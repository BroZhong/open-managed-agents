#!/usr/bin/env bash
# Skill Install (ADR-0022), run by the Sandbox Manager as root inside a
# Sandbox: `bash -c "$(cat skill-install.sh)" oma-skill-install`.
#
# It places one Skill Set version at /opt/oma/skills/<setHash>/<name> and
# atomically points the /skills symlink at it. Extracted bundles are cached
# under /opt/oma/skills/bundles/<sha256>, so only bundles this Sandbox does not
# hold yet are downloaded; a version directory is assembled from them with hard
# links, so /skills/<name> is a real directory tree.
#
# The request arrives on stdin as newline-terminated records, read with a
# timeout, because the Sandbox's envd cannot close stdin (no EOF):
#   oma-skill-install/1 <setHash> <bundleCount> <budgetSeconds>
#   <sha256> <base64(skillName)> <signedUrl>        (bundleCount records)
# Signed URLs live only in shell variables and reach curl through its stdin
# config (--config -): never argv, env, a file or output. Output is progress
# lines `OMA_SKILLS_STAGE <stage>` and one `OMA_SKILLS_RESULT <json>` line,
# built from fixed words and numbers only.
#
# Concurrent installers in one Sandbox (two Runners, a parent and its
# children) serialise on a lock file. Independently of the lock, a version or
# bundle directory appears only through a rename after it is complete, and a
# complete one is never rewritten, so an interrupted install leaves only work
# directories behind and /skills keeps its old target.
#
# Every switch of /skills takes the Sandbox's next switch generation under the
# lock and reports it: installs may record in any order, and the record of the
# highest generation names what /skills points at.
set -uo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8
umask 022

root=/opt/oma/skills
link=/skills
stage=start
step() { stage=$1; printf 'OMA_SKILLS_STAGE %s\n' "$1"; }
fail() { printf 'OMA_SKILLS_RESULT {"ok":false,"stage":"%s","reason":"%s"}\n' "$stage" "$1"; exit 1; }
short() { printf '%s' "${1:0:12}"; }

step start
IFS=' ' read -r -t 30 magic set_hash count budget || fail "no install request arrived on stdin"
[[ ${magic:-} == oma-skill-install/1 && ${set_hash:-} =~ ^[0-9a-f]{64}$ &&
  ${count:-} =~ ^(0|[1-9][0-9]{0,3})$ && ${budget:-} =~ ^[1-9][0-9]{0,4}$ ]] || fail "malformed install request"
url_re='^https://[A-Za-z0-9.-]+/[A-Za-z0-9._~%/=&?:+-]+$'
names=() shas=() urls=()
declare -A seen=() url_of=()
for ((i = 0; i < count; i++)); do
  IFS=' ' read -r -t 30 sha name64 url || fail "the install request ended early"
  [[ ${sha:-} =~ ^[0-9a-f]{64}$ && ${name64:-} =~ ^[A-Za-z0-9+/]+=*$ ]] || fail "malformed install record"
  [[ ${url:-} =~ $url_re ]] || fail "malformed install URL"
  # Skill names exclude only "/" and control characters, so they travel base64-encoded.
  name=$(printf '%s' "$name64" | base64 -d 2>/dev/null) || fail "malformed Skill name"
  [[ -n $name && $name != . && $name != .. && $name != */* && $name != *[[:cntrl:]]* && -z ${seen[$name]:-} ]] ||
    fail "invalid or duplicate Skill name"
  seen[$name]=1
  names+=("$name") shas+=("$sha") urls+=("$url")
  url_of[$sha]=$url
done
# Stdin stays open; nothing below may read it.
exec 0</dev/null
for tool in curl unzip sha256sum flock; do
  command -v "$tool" >/dev/null 2>&1 || fail "the Sandbox image has no $tool"
done

mkdir -p "$root/bundles" && chmod 0755 /opt/oma "$root" "$root/bundles" || fail "cannot create $root"
exec 9>"$root/.lock" || fail "cannot open the install lock"
flock -w "$budget" 9 || fail "another Skill Install held the lock for $budget s"

dest=$root/$set_hash
reused=1 downloaded=0 bytes=0 legacy=0
work=""
trap 'if [[ -n $work ]]; then rm -rf "$work"; fi' EXIT
if [[ ! -d $dest ]]; then
  # A version directory only appears through the rename below, after every
  # bundle in it was verified, so its existence means it is complete.
  reused=0
  work=$(mktemp -d "$root/.work-XXXXXXXX") || fail "cannot create a work directory"
  mkdir "$work/dl" "$work/tree" || fail "cannot create a work directory"
  missing=()
  declare -A wanted=()
  for sha in "${shas[@]}"; do
    [[ -n ${wanted[$sha]:-} ]] && continue
    wanted[$sha]=1
    [[ -d $root/bundles/$sha ]] || missing+=("$sha")
  done

  pending=("${missing[@]}")
  last=""
  for round in 1 2; do
    ((${#pending[@]} > 0)) || break
    ((round == 1)) || sleep 1
    step download
    report=$(for sha in "${pending[@]}"; do
        printf 'url = "%s"\noutput = "%s/dl/%s.zip"\n' "${url_of[$sha]}" "$work" "$sha"
      done | curl --noproxy '*' --config - --parallel --parallel-max 8 --silent \
        --connect-timeout 5 --max-time "$budget" \
        --write-out '%{http_code} %{exitcode} %{filename_effective}\n' 2>/dev/null) || true
    unset result
    declare -A result=()
    while read -r http code file; do
      [[ ${file:-} =~ /dl/([0-9a-f]{64})\.zip$ ]] || continue
      result[${BASH_REMATCH[1]}]="$http $code"
    done <<<"$report"
    step verify
    retry=()
    for sha in "${pending[@]}"; do
      f=$work/dl/$sha.zip
      outcome=${result[$sha]:-"000 none"}
      if [[ $outcome != "200 0" || ! -f $f ]]; then
        last="download:HTTP ${outcome% *}, curl exit ${outcome#* } for bundle $(short "$sha")"
      elif [[ $(sha256sum "$f" | cut -d' ' -f1) != "$sha" ]]; then
        last="verify:sha256 mismatch for bundle $(short "$sha")"
      else
        continue
      fi
      rm -f "$f"
      retry+=("$sha")
    done
    pending=("${retry[@]}")
  done
  if ((${#pending[@]} > 0)); then stage=${last%%:*}; fail "${last#*:}"; fi

  step extract
  for sha in "${missing[@]}"; do
    f=$work/dl/$sha.zip
    t=$work/bundle-$sha
    mkdir "$t" || fail "cannot create a work directory"
    # 22 bytes is the end record alone: a Skill without files, which unzip refuses.
    if [[ $(stat -c %s "$f") != 22 ]]; then
      entries=$(unzip -Z1 "$f" 2>/dev/null) || fail "cannot list bundle $(short "$sha")"
      # Refuse absolute, parent-relative and backslash entry names outright
      # instead of relying on unzip's silent stripping.
      grep -qE '(^/|(^|/)\.\.(/|$)|\\)' <<<"$entries" && fail "bundle $(short "$sha") has an unsafe entry"
      unzip -qq "$f" -d "$t" >/dev/null 2>&1 || fail "cannot extract bundle $(short "$sha")"
    fi
    [[ -z $(find "$t" ! -type f ! -type d -print -quit) ]] || fail "bundle $(short "$sha") has a special file"
    chown -R 0:0 "$t" &&
      find "$t" -type f -perm /111 -exec chmod 0555 {} + &&
      find "$t" -type f ! -perm /111 -exec chmod 0444 {} + &&
      find "$t" -type d -exec chmod 0555 {} + || fail "cannot set permissions on bundle $(short "$sha")"
    bytes=$((bytes + $(stat -c %s "$f")))
    downloaded=$((downloaded + 1))
    # Complete bundles are never rewritten: one that appeared meanwhile is equal.
    mv -T "$t" "$root/bundles/$sha" 2>/dev/null || [[ -d $root/bundles/$sha ]] || fail "cannot store bundle $(short "$sha")"
  done
  for ((i = 0; i < count; i++)); do
    [[ -d $root/bundles/${shas[i]} ]] || fail "bundle $(short "${shas[i]}") disappeared before assembly"
    cp -al "$root/bundles/${shas[i]}" "$work/tree/${names[i]}" || fail "cannot assemble Skill $((i + 1)) of $count"
  done
  { ((count == 0)) || printf '%s\n' "${shas[@]}"; } | sort -u >"$work/bundles" || fail "cannot write the version manifest"
  chown 0:0 "$work/tree" && chmod 0555 "$work/tree" || fail "cannot set permissions on the version"
  # The manifest names the bundles a version references; it precedes the version.
  mv -f "$work/bundles" "$dest.bundles" || fail "cannot store the version manifest"
  mv -T "$work/tree" "$dest" 2>/dev/null || [[ -d $dest ]] || fail "cannot store the version"
fi

step switch
# The next generation, reuse and unchanged targets included. Never below the
# clock in milliseconds, so a lost counter cannot fall behind a recorded one.
counter=$(cat "$root/.generation" 2>/dev/null)
[[ $counter =~ ^[1-9][0-9]{0,17}$ ]] || counter=0
clock=$(($(date +%s%N) / 1000000))
generation=$((counter + 1 > clock ? counter + 1 : clock))
{ printf '%s\n' "$generation" >"$root/.generation.next" && mv -f "$root/.generation.next" "$root/.generation"; } ||
  fail "cannot advance the switch generation"
previous=""
moved=""
if [[ -L $link ]]; then
  previous=$(readlink "$link")
elif [[ -e $link ]]; then
  # A real directory left by the Read-only Projection of earlier Runners.
  moved=$root/legacy-$(date +%s%N)
  mv -T "$link" "$moved" || fail "cannot move the legacy $link directory aside"
  legacy=1
fi
next=/.skills-next.$$
if ! { ln -sfn "$dest" "$next" && mv -Tf "$next" "$link"; }; then
  rm -f "$next"
  [[ -n $moved ]] && mv -T "$moved" "$link"
  fail "cannot switch $link"
fi
[[ $(readlink "$link") == "$dest" ]] || fail "$link does not point at the installed version"
[[ -n $moved ]] && rm -rf "$moved"

# Keep the current and the previous version and the bundles they reference.
# Cleanup is best effort: a failure leaves only disk usage behind.
if [[ $previous != "$dest" ]]; then
  keep=""
  [[ $previous =~ ^$root/([0-9a-f]{64})$ ]] && keep=${BASH_REMATCH[1]}
  declare -A referenced=()
  for version in "$set_hash" "$keep"; do
    [[ -n $version && -f $root/$version.bundles ]] || continue
    while read -r sha; do [[ $sha =~ ^[0-9a-f]{64}$ ]] && referenced[$sha]=1; done <"$root/$version.bundles"
  done
  for entry in "$root"/*; do
    name=${entry##*/}
    if [[ $name =~ ^[0-9a-f]{64}$ && $name != "$set_hash" && $name != "$keep" ]]; then
      rm -rf "$entry" "$entry.bundles"
    elif [[ $name =~ ^([0-9a-f]{64})\.bundles$ && ! -d $root/${BASH_REMATCH[1]} ]]; then
      rm -f "$entry"
    fi
  done
  for entry in "$root"/bundles/*; do
    name=${entry##*/}
    [[ $name =~ ^[0-9a-f]{64}$ && -z ${referenced[$name]:-} ]] && rm -rf "$entry"
  done
  # Left by installs killed mid-way; never younger ones, which may still be in use.
  find "$root" -mindepth 1 -maxdepth 1 \( -name '.work-*' -o -name 'legacy-*' \) -mmin +30 \
    -exec rm -rf {} + 2>/dev/null
fi

printf 'OMA_SKILLS_RESULT {"ok":true,"stage":"done","reused":%d,"skills":%d,"downloaded":%d,"bytes":%d,"legacy":%d,"generation":%d}\n' \
  "$reused" "$count" "$downloaded" "$bytes" "$legacy" "$generation"
exit 0

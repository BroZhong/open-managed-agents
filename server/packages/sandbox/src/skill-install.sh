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
#
# The lock is held on fd 9 by this shell alone. Every child closes it (`9>&-`
# on each command, `exec 9>&-` first in each command substitution or
# subshell), so a kill of this shell releases the lock at once even while a
# child, such as a running download, outlives it.
set -uo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8
umask 022

root=/opt/oma/skills
link=/skills
stage=start
step() { stage=$1; printf 'OMA_SKILLS_STAGE %s\n' "$1"; }
fail() { printf 'OMA_SKILLS_RESULT {"ok":false,"stage":"%s","reason":"%s"}\n' "$stage" "$1"; exit 1; }

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
trap 'if [[ -n $work ]]; then rm -rf "$work" 9>&-; fi' EXIT
if [[ ! -d $dest ]]; then
  # A version directory only appears through the rename below, after every
  # bundle in it was verified, so its existence means it is complete.
  reused=0
  work=$(exec 9>&-; mktemp -d "$root/.work-XXXXXXXX") || fail "cannot create a work directory"
  mkdir "$work/dl" "$work/tree" 9>&- || fail "cannot create a work directory"
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
    ((round == 1)) || sleep 1 9>&-
    step download
    report=$(exec 9>&-; for sha in "${pending[@]}"; do
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
        last="download:HTTP ${outcome% *}, curl exit ${outcome#* } for bundle ${sha:0:12}"
      elif [[ $(exec 9>&-; sha256sum "$f" | cut -d' ' -f1) != "$sha" ]]; then
        last="verify:sha256 mismatch for bundle ${sha:0:12}"
      else
        continue
      fi
      rm -f "$f" 9>&-
      retry+=("$sha")
    done
    pending=("${retry[@]}")
  done
  if ((${#pending[@]} > 0)); then stage=${last%%:*}; fail "${last#*:}"; fi

  step extract
  for sha in "${missing[@]}"; do
    f=$work/dl/$sha.zip
    t=$work/bundle-$sha
    mkdir "$t" 9>&- || fail "cannot create a work directory"
    # 22 bytes is the end record alone: a Skill without files, which unzip refuses.
    if [[ $(exec 9>&-; stat -c %s "$f") != 22 ]]; then
      entries=$(exec 9>&-; unzip -Z1 "$f" 2>/dev/null) || fail "cannot list bundle ${sha:0:12}"
      # Refuse absolute, parent-relative and backslash entry names outright
      # instead of relying on unzip's silent stripping.
      grep -qE '(^/|(^|/)\.\.(/|$)|\\)' <<<"$entries" 9>&- && fail "bundle ${sha:0:12} has an unsafe entry"
      unzip -qq "$f" -d "$t" >/dev/null 2>&1 9>&- || fail "cannot extract bundle ${sha:0:12}"
    fi
    [[ -z $(exec 9>&-; find "$t" ! -type f ! -type d -print -quit) ]] || fail "bundle ${sha:0:12} has a special file"
    chown -R 0:0 "$t" 9>&- &&
      find "$t" -type f -perm /111 -exec chmod 0555 {} + 9>&- &&
      find "$t" -type f ! -perm /111 -exec chmod 0444 {} + 9>&- &&
      find "$t" -type d -exec chmod 0555 {} + 9>&- || fail "cannot set permissions on bundle ${sha:0:12}"
    bytes=$((bytes + $(exec 9>&-; stat -c %s "$f")))
    downloaded=$((downloaded + 1))
    # Complete bundles are never rewritten: one that appeared meanwhile is equal.
    mv -T "$t" "$root/bundles/$sha" 2>/dev/null 9>&- || [[ -d $root/bundles/$sha ]] || fail "cannot store bundle ${sha:0:12}"
  done
  for ((i = 0; i < count; i++)); do
    [[ -d $root/bundles/${shas[i]} ]] || fail "bundle ${shas[i]:0:12} disappeared before assembly"
    cp -al "$root/bundles/${shas[i]}" "$work/tree/${names[i]}" 9>&- || fail "cannot assemble Skill $((i + 1)) of $count"
  done
  (exec 9>&-; { ((count == 0)) || printf '%s\n' "${shas[@]}"; } | sort -u >"$work/bundles") || fail "cannot write the version manifest"
  chown 0:0 "$work/tree" 9>&- && chmod 0555 "$work/tree" 9>&- || fail "cannot set permissions on the version"
  # The manifest names the bundles a version references; it precedes the version.
  mv -f "$work/bundles" "$dest.bundles" 9>&- || fail "cannot store the version manifest"
  mv -T "$work/tree" "$dest" 2>/dev/null 9>&- || [[ -d $dest ]] || fail "cannot store the version"
fi

step switch
# The next generation, reuse and unchanged targets included. Never below the
# clock in milliseconds, so a lost counter cannot fall behind a recorded one.
counter=0
read -r counter <"$root/.generation" 2>/dev/null
[[ $counter =~ ^[1-9][0-9]{0,17}$ ]] || counter=0
now=${EPOCHREALTIME/[.,]/}
clock=$((now / 1000))
generation=$((counter + 1 > clock ? counter + 1 : clock))
{ printf '%s\n' "$generation" >"$root/.generation.next" && mv -f "$root/.generation.next" "$root/.generation" 9>&-; } ||
  fail "cannot advance the switch generation"
previous=""
moved=""
if [[ -L $link ]]; then
  previous=$(exec 9>&-; readlink "$link")
elif [[ -e $link ]]; then
  # A real directory left by the Read-only Projection of earlier Runners.
  moved=$root/legacy-${EPOCHREALTIME/[.,]/}
  mv -T "$link" "$moved" 9>&- || fail "cannot move the legacy $link directory aside"
  legacy=1
fi
next=/.skills-next.$$
if ! { ln -sfn "$dest" "$next" 9>&- && mv -Tf "$next" "$link" 9>&-; }; then
  rm -f "$next" 9>&-
  [[ -n $moved ]] && mv -T "$moved" "$link" 9>&-
  fail "cannot switch $link"
fi
[[ $(exec 9>&-; readlink "$link") == "$dest" ]] || fail "$link does not point at the installed version"
[[ -n $moved ]] && rm -rf "$moved" 9>&-

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
      rm -rf "$entry" "$entry.bundles" 9>&-
    elif [[ $name =~ ^([0-9a-f]{64})\.bundles$ && ! -d $root/${BASH_REMATCH[1]} ]]; then
      rm -f "$entry" 9>&-
    fi
  done
  for entry in "$root"/bundles/*; do
    name=${entry##*/}
    [[ $name =~ ^[0-9a-f]{64}$ && -z ${referenced[$name]:-} ]] && rm -rf "$entry" 9>&-
  done
  # Left by installs killed mid-way; never younger ones, which may still be in use.
  find "$root" -mindepth 1 -maxdepth 1 \( -name '.work-*' -o -name 'legacy-*' \) -mmin +30 \
    -exec rm -rf {} + 2>/dev/null 9>&-
fi

printf 'OMA_SKILLS_RESULT {"ok":true,"stage":"done","reused":%d,"skills":%d,"downloaded":%d,"bytes":%d,"legacy":%d,"generation":%d}\n' \
  "$reused" "$count" "$downloaded" "$bytes" "$legacy" "$generation"
exit 0

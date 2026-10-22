#!/usr/bin/env bash
# Skill bundle installer for the #261 spike, run as root inside a Sandbox by
# deploy/scripts/verify-skill-bundle-install.mts. It models the install step
# the Runner will perform (#265); it is not production code.
#
# The request arrives on stdin as newline-terminated records, so the protocol
# never needs EOF (the gateway reports envd 0.2.10, which cannot close stdin):
#   OMA1 <setHash> <bundleCount> <limitRateBytesPerSecond, 0 = unlimited>
#   <sha256> <sizeBytes> <base64(skillName)> <signedUrl>   (bundleCount records)
# Signed URLs live only in shell variables and reach curl through its stdin
# config (--config -). They never appear in argv, files or output. The only
# output is one JSON summary line built from numbers and fixed stage names.
set -euo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8
umask 022

ms() { local t; t=$(date +%s%N); echo $((t / 1000000)); }
fail() { printf '{"ok":false,"stage":"%s"}\n' "$1"; exit 1; }

t_start=$(ms)
IFS=' ' read -r -t 30 magic set_hash count rate || fail stdin-header
[[ $magic == OMA1 && $set_hash =~ ^[0-9a-f]{64}$ && $count =~ ^[1-9][0-9]{0,3}$ && $rate =~ ^[0-9]{1,12}$ ]] || fail header

url_re='^https://[A-Za-z0-9.-]+/[A-Za-z0-9._~%/=&?:+-]+$'
names=() shas=() sizes=() urls=()
declare -A seen=()
for ((i = 0; i < count; i++)); do
  IFS=' ' read -r -t 30 sha size name64 url || fail stdin-record
  [[ $sha =~ ^[0-9a-f]{64}$ && $size =~ ^[0-9]{1,12}$ && $name64 =~ ^[A-Za-z0-9+/]+=*$ ]] || fail record
  [[ $url =~ $url_re ]] || fail record-url
  # Skill names only exclude "/", so they travel base64-encoded.
  name=$(printf '%s' "$name64" | base64 -d) || fail record-name
  [[ -n $name && $name != . && $name != .. && $name != */* && $name != *$'\n'* && -z ${seen[$name]:-} ]] || fail record-name
  seen[$name]=1
  names+=("$name") shas+=("$sha") sizes+=("$size") urls+=("$url")
done
t_read=$(ms)

root=/opt/oma/skills
dest=$root/$set_hash
mkdir -p "$root"
# Serialise installers sharing one Sandbox (parent and child Sessions).
exec 9>"$root/.lock"
flock -w 120 9 || fail lock
t_locked=$(ms)

reused=0 bytes=0 attempts=0 errors=0 connects=0 exec_before=0 bad_codes=""
ms_download=0 ms_verify=0 ms_extract=0 ms_permissions=0
if [[ -d $dest ]]; then
  # A version directory only appears through the final rename below, after
  # every byte was verified, so its existence means it is complete.
  reused=1
else
  work=$(mktemp -d "$root/.work-XXXXXXXX")
  trap 'rm -rf "$work"' EXIT
  mkdir "$work/dl" "$work/tree"
  limit=()
  if ((rate > 0)); then limit=(--limit-rate "$rate"); fi
  pending=()
  for ((i = 0; i < count; i++)); do pending+=("$i"); done
  for round in 1 2 3; do
    ((${#pending[@]} > 0)) || break
    ((round == 1)) || sleep 1
    t=$(ms)
    report=$(for i in "${pending[@]}"; do
        printf 'url = "%s"\noutput = "%s/dl/%s.zip"\n' "${urls[i]}" "$work" "$i"
      done | curl --noproxy '*' --config - --parallel --parallel-max 8 --silent \
        --connect-timeout 5 --max-time 120 "${limit[@]}" \
        --write-out '%{http_code} %{exitcode} %{num_connects} %{filename_effective}\n' 2>/dev/null) || true
    ms_download=$((ms_download + $(ms) - t))
    declare -A result=()
    while read -r http code conns file; do
      [[ ${file:-} =~ /dl/([0-9]+)\.zip$ ]] || continue
      result[${BASH_REMATCH[1]}]="$http:$code"
      connects=$((connects + conns))
    done <<<"$report"
    t=$(ms)
    retry=()
    for i in "${pending[@]}"; do
      attempts=$((attempts + 1))
      f="$work/dl/$i.zip"
      if [[ ${result[$i]:-none} == 200:0 && -f $f && $(stat -c %s "$f") == "${sizes[i]}" &&
            $(sha256sum "$f" | cut -d' ' -f1) == "${shas[i]}" ]]; then
        bytes=$((bytes + sizes[i]))
      else
        errors=$((errors + 1)) bad_codes+="${result[$i]:-none},"
        rm -f "$f"
        retry+=("$i")
      fi
    done
    ms_verify=$((ms_verify + $(ms) - t))
    pending=("${retry[@]}")
  done
  ((${#pending[@]} == 0)) || fail download

  t=$(ms)
  for ((i = 0; i < count; i++)); do
    f="$work/dl/$i.zip"
    entries=$(unzip -Z1 "$f") || fail zip-list
    # Refuse absolute, parent-relative and backslash entry names outright
    # instead of relying on unzip's silent stripping.
    if grep -qE '(^/|(^|/)\.\.(/|$)|\\)' <<<"$entries"; then fail zip-unsafe-entry; fi
    mkdir "$work/tree/${names[i]}"
    unzip -qq "$f" -d "$work/tree/${names[i]}" || fail unzip
  done
  [[ -z $(find "$work/tree" ! -type f ! -type d -print -quit) ]] || fail zip-special-file
  exec_before=$(find "$work/tree" -type f -perm /111 | wc -l)
  ms_extract=$(($(ms) - t))

  t=$(ms)
  chown -R 0:0 "$work/tree"
  find "$work/tree" -type d -exec chmod 0555 {} +
  find "$work/tree" -type f -perm /111 -exec chmod 0555 {} +
  find "$work/tree" -type f ! -perm /111 -exec chmod 0444 {} +
  ms_permissions=$(($(ms) - t))
  mv -T "$work/tree" "$dest"
fi

t=$(ms)
if [[ -e /skills && ! -L /skills ]]; then fail legacy-skills-dir; fi
ln -sfn "$dest" "/.skills-next.$$"
mv -Tf "/.skills-next.$$" /skills
[[ $(readlink /skills) == "$dest" ]] || fail switch
t_end=$(ms)

printf '{"ok":true,"reused":%d,"bundles":%d,"bytes":%d,"attempts":%d,"errors":%d,"badCodes":"%s","connects":%d,"execFilesBeforeNormalize":%d,"ms":{"readStdin":%d,"lock":%d,"download":%d,"verify":%d,"extract":%d,"permissions":%d,"switch":%d,"total":%d}}\n' \
  "$reused" "$count" "$bytes" "$attempts" "$errors" "${bad_codes%,}" "$connects" "$exec_before" \
  $((t_read - t_start)) $((t_locked - t_read)) "$ms_download" "$ms_verify" "$ms_extract" "$ms_permissions" \
  $((t_end - t)) $((t_end - t_start))

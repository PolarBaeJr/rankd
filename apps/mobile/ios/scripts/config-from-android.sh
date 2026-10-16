#!/bin/sh
# Writes Config/Local.xcconfig from ../android/local.properties, so both apps
# point at the same environment. Prints only which keys it set and the two
# hosts; the anon key itself is never printed.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
props="$here/../android/local.properties"
out="$here/Config/Local.xcconfig"

if [ ! -f "$props" ]; then
  echo "No $props: copy local.properties.example there first." >&2
  exit 1
fi

# The last value for a key, with Java properties escapes (\: and \=) undone.
prop() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*[=:][[:space:]]*//p" "$props" | tail -n 1 |
    sed -e 's/\\:/:/g' -e 's/\\=/=/g' -e 's/[[:space:]]*$//'
}

# xcconfig reads // as a comment, so the scheme is dropped; Info.plist puts
# https:// back. Anything that is not https is left out and the app shows its
# configuration screen, as the Android build does.
address() {
  case "$1" in
    https://*|HTTPS://*) printf '%s' "${1#*://}" | sed 's:/*$::' ;;
    *) printf '' ;;
  esac
}

supabase=$(address "$(prop badminton.supabaseUrl)")
anon=$(prop badminton.supabaseAnonKey)
site=$(address "$(prop badminton.siteUrl)")

umask 077
{
  echo "// Written by scripts/config-from-android.sh. Gitignored: never commit."
  echo "BADMINTON_SUPABASE_ADDRESS = $supabase"
  echo "BADMINTON_SUPABASE_ANON_KEY = $anon"
  echo "BADMINTON_SITE_ADDRESS = $site"
} > "$out"
chmod 600 "$out"

set_or_empty() { if [ -n "$2" ]; then echo "$1: set"; else echo "$1: EMPTY"; fi; }
set_or_empty BADMINTON_SUPABASE_ADDRESS "$supabase"
set_or_empty BADMINTON_SUPABASE_ANON_KEY "$anon"
set_or_empty BADMINTON_SITE_ADDRESS "$site"
echo "Supabase host: ${supabase%%/*}"
echo "Site host: ${site%%/*}"

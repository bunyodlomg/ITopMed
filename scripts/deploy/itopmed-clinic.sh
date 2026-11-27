#!/usr/bin/env bash
# Open a clinic ready to work from a spec (asks for the owner's password; it is never put on the command line).
#   sudo /opt/itopmed/bin/itopmed-clinic farhod-medservis owner.login "Owner Full Name"   (asks the password)
#   sudo /opt/itopmed/bin/itopmed-clinic farhod-medservis --update     (existing clinic: add new templates, apply the price list, fill empty letterhead fields)
set -euo pipefail
SPEC="${1:?clinic spec name, e.g. farhod-medservis}"
FILE="/opt/itopmed/current/clinics/$SPEC.json"
[ -f "$FILE" ] || { echo "No such clinic spec: $FILE" >&2; ls /opt/itopmed/current/clinics >&2; exit 1; }
set -a; . /etc/itopmed/itopmed.env; set +a
cd /opt/itopmed/current/app
# Existing clinic: the owner's administration from a list of operations (roles, staff, test patients).
#   sudo /opt/itopmed/bin/itopmed-clinic farhod-medservis --admin /root/ops.json   (see scripts/lib/clinic-admin.ts)
if [ "${2:-}" = "--admin" ]; then
  OPS="${3:?ops.json}"
  [ -f "$OPS" ] || { echo "No such file: $OPS" >&2; exit 1; }
  # Read here (root may keep the file private); the task reads it from stdin.
  exec runuser -p -u itopmed -- /opt/itopmed/node/bin/node tasks.mjs clinic-admin "$SPEC" /dev/stdin < "$OPS"
fi
# Existing clinic: add new templates / empty letterhead fields from the spec (nothing is overwritten).
if [ "${2:-}" = "--update" ]; then
  exec runuser -p -u itopmed -- /opt/itopmed/node/bin/node tasks.mjs update-clinic "$FILE"
fi
LOGIN="${2:?owner login}"; NAME="${3:?owner full name}"
exec runuser -p -u itopmed -- /opt/itopmed/node/bin/node tasks.mjs create-clinic "$FILE" "$LOGIN" "$NAME"

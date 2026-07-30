#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: test-rpm-package.sh <rpm>" >&2
  exit 2
fi

rpm_path="$(realpath "$1")"
test -f "$rpm_path"
package_name="$(rpm -qp --queryformat '%{NAME}' "$rpm_path")"
test -n "$package_name"

dnf install -y "$rpm_path" xorg-x11-server-Xvfb findutils procps-ng
executable="/usr/bin/$package_name"
desktop_file="/usr/share/applications/$package_name.desktop"
test -x "$executable"
test -f "$desktop_file"
grep -Fqx 'Categories=Network;InstantMessaging;Chat;' "$desktop_file"
grep -Eq "^Exec=.*${package_name}" "$desktop_file"
grep -Eq '^Icon=.+$' "$desktop_file"
find /usr/share/icons/hicolor \
  -path "*/apps/$package_name.png" -type f -print -quit |
  grep -q .
ISSUE53_SMOKE_LOG_DIR=/tmp/messenger-rpm-smoke \
  ./scripts/test-issue53-linux-vm-smoke.sh executable "$executable"
dnf remove -y "$package_name"
test ! -e "$executable"
test ! -e "$desktop_file"
test -z "$(
  find /usr/share/icons/hicolor \
    -path "*/apps/$package_name.png" -type f -print -quit
)"
echo "RPM install, launch, and uninstall passed: $rpm_path"

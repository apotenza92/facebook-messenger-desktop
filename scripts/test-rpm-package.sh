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
test -x "$executable"
ISSUE53_SMOKE_LOG_DIR=/tmp/messenger-rpm-smoke \
  ./scripts/test-issue53-linux-vm-smoke.sh executable "$executable"
dnf remove -y "$package_name"
test ! -e "$executable"
echo "RPM install, launch, and uninstall passed: $rpm_path"

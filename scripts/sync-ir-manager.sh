#!/bin/sh
# Copy the AcoustiMatch pedal IR Manager from the firmware repo into the site.
# The firmware repo's web/ folder is the source of truth; don't edit the copy.
#
# The page is unlisted (beta): it isn't linked from the site, isn't in the
# sitemap (public/ files never are), and gets a noindex tag here.
#
# Usage: scripts/sync-ir-manager.sh [path/to/acoustimatch-daisy/web]
set -eu

SRC="${1:-$HOME/projects/daisy-seed/acoustimatch-daisy/web}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/software/acoustimatch/ir-manager"

for f in index.html app.js protocol.js wav.js; do
  [ -f "$SRC/$f" ] || { echo "missing $SRC/$f" >&2; exit 1; }
done

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$SRC/app.js" "$SRC/protocol.js" "$SRC/wav.js" "$DEST/"
sed 's|<meta charset="utf-8">|<meta charset="utf-8">\
<meta name="robots" content="noindex, nofollow">|' "$SRC/index.html" > "$DEST/index.html"

grep -q 'name="robots"' "$DEST/index.html" || { echo "noindex tag not inserted" >&2; exit 1; }
echo "Synced IR Manager into $DEST"

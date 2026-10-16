#!/usr/bin/env bash
# Compara a versão fixada em upstream/ com a última versão estável do VSCodium.
# Imprime variáveis no formato do $GITHUB_OUTPUT:
#   outdated=yes|no, current=<tag do VS Code>, latest=<tag do VS Code>,
#   vscodium_tag=<tag do VSCodium>, vscodium_commit=<commit>

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOSITORY="$(jq -r '.repository' "${ROOT}/upstream/vscodium.json")"
RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/VSCodium/vscodium}"

# Tags estáveis do VSCodium: 1.135.06055 (versão do VS Code + contador).
latest_line="$(git ls-remote --tags --refs "${REPOSITORY}" \
  | grep -E 'refs/tags/[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -t/ -k3 -V \
  | tail -1)"
vscodium_commit="${latest_line%%[[:space:]]*}"
vscodium_tag="${latest_line##*/}"

latest="$(curl --silent --fail "${RAW_BASE}/${vscodium_commit}/upstream/stable.json" | jq -r '.tag')"
current="$(jq -r '.tag' "${ROOT}/upstream/stable.json")"

outdated="no"
if [[ "$(printf '%s\n%s\n' "${current}" "${latest}" | sort -V | tail -1)" != "${current}" ]]; then
  outdated="yes"
fi

echo "outdated=${outdated}"
echo "current=${current}"
echo "latest=${latest}"
echo "vscodium_tag=${vscodium_tag}"
echo "vscodium_commit=${vscodium_commit}"

#!/usr/bin/env bash
# Baixa o Code-OSS na versão fixada em upstream/stable.json para dentro de
# .build/vscodium/vscode. Separado do build.sh para o CI poder restaurar o cache
# de dependências depois de saber a versão e antes de instalar.
#
# No GitHub Actions, MS_TAG, MS_COMMIT e RELEASE_VERSION vão para o GITHUB_ENV
# e o build.sh reaproveita o checkout.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${FAKL_BUILD_DIR:-${ROOT}/.build}"

# shellcheck source=build/env.sh
. "${ROOT}/build/env.sh"

if [[ ! -d "${WORK}/vscodium" ]]; then
  "${ROOT}/build/prepare.sh"
fi

cd "${WORK}/vscodium"
rm -rf vscode

# Os scripts do VSCodium usam variáveis opcionais sem valor padrão.
set +u
# shellcheck disable=SC1091
. ./get_repo.sh

#!/usr/bin/env bash
# Compila a FaKL-Code IDE e gera os instaladores em .build/vscodium/assets.
#
# Requer as variáveis OS_NAME (osx | windows | linux) e VSCODE_ARCH (x64 | arm64), e
# as ferramentas que o VSCodium pede (Node da .nvmrc dele, Python 3, jq, git;
# no Windows, Inno Setup e 7-Zip, que já vêm nos runners do GitHub).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${FAKL_BUILD_DIR:-${ROOT}/.build}"

: "${OS_NAME:?defina OS_NAME (osx, windows ou linux)}"
: "${VSCODE_ARCH:?defina VSCODE_ARCH (x64 ou arm64)}"

# shellcheck source=build/env.sh
. "${ROOT}/build/env.sh"

if [[ ! -d "${WORK}/vscodium" ]]; then
  "${ROOT}/build/prepare.sh"
fi

cd "${WORK}/vscodium"

# Faz o build.sh do VSCodium compilar e empacotar no mesmo job, inclusive no
# Windows, onde o fluxo dele separa as duas etapas.
export CI_BUILD="no"
export SHOULD_BUILD="yes"

# Os scripts do VSCodium usam variáveis opcionais sem valor padrão.
set +u
if [[ -d vscode/.git && -n "${MS_COMMIT:-}" ]]; then
  # O build/fetch.sh já baixou o Code-OSS (no CI, em um passo anterior).
  export MS_TAG MS_COMMIT RELEASE_VERSION
else
  # shellcheck disable=SC1091
  . ./get_repo.sh
fi
./build.sh

if [[ "${OS_NAME}" == "osx" && -z "${CERTIFICATE_OSX_P12_DATA:-}" ]]; then
  # Sem certificado da Apple, assina ad hoc: o macOS em arm64 não abre apps
  # sem nenhuma assinatura. O Gatekeeper ainda pede liberação manual.
  echo "==> Assinatura ad hoc"
  # O bundle leva o nameLong do product.json ("FaKL-Code IDE.app"), não o
  # APP_NAME; por isso procura o .app em vez de montar o nome.
  shopt -s nullglob
  apps=("VSCode-darwin-${VSCODE_ARCH}"/*.app)
  shopt -u nullglob
  if [[ ${#apps[@]} -ne 1 ]]; then
    echo "esperava um .app em VSCode-darwin-${VSCODE_ARCH}, achei ${#apps[@]}" >&2
    exit 1
  fi
  codesign --force --deep --sign - "${apps[0]}"
  codesign --verify --deep --strict "${apps[0]}"
fi

if [[ "${OS_NAME}" == "linux" ]]; then
  # Com CI_BUILD=no o prepare_assets.sh do VSCodium também constrói o snap, que exige o
  # snapcraft e não é um formato que publicamos (tar.gz, deb e rpm bastam).
  echo "==> Sem snap"
  sed -i.bak \
    -e 's#\. \./stores/snapcraft/build\.sh#true#' \
    -e 's#mv stores/snapcraft/build/\*\.snap assets/#true#' \
    build/linux/prepare_assets.sh
  rm -f build/linux/prepare_assets.sh.bak
  grep -q 'snapcraft' build/linux/prepare_assets.sh && {
    echo "o prepare_assets.sh do VSCodium ainda chama o snapcraft" >&2
    exit 1
  }
fi

echo "==> Pacote de idioma pt-BR no app"
# Confere que o gulp empacotou o pacote embutido pelo prepare.sh (ADR 0036).
pack_name="$(jq -r '.id' "${ROOT}/upstream/language-pack-pt-br.json")"
if [[ -z "$(find VSCode-* -ipath "*/resources/app/extensions/${pack_name#*.}/translations/main.i18n.json" -print -quit)" ]]; then
  echo "o pacote de idioma pt-BR não entrou no app compilado" >&2
  exit 1
fi

./prepare_assets.sh

echo "==> Instaladores gerados:"
ls -la assets

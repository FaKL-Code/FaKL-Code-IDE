#!/usr/bin/env bash
# Monta a árvore de build: baixa os scripts do VSCodium na versão fixada em
# upstream/vscodium.json e aplica por cima a marca, o product.json, a versão do
# Code-OSS e os patches da FaKL-Code (SDD 5.3).
#
# Uso: build/prepare.sh            (cria .build/vscodium)
#      FAKL_BUILD_DIR=/tmp/x build/prepare.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${FAKL_BUILD_DIR:-${ROOT}/.build}"
DEST="${WORK}/vscodium"

REPOSITORY="$(jq -r '.repository' "${ROOT}/upstream/vscodium.json")"
COMMIT="$(jq -r '.commit' "${ROOT}/upstream/vscodium.json")"

echo "==> VSCodium ${COMMIT} em ${DEST}"
rm -rf "${DEST}"
mkdir -p "${DEST}"
git -C "${DEST}" init -q
git -C "${DEST}" remote add origin "${REPOSITORY}"
git -C "${DEST}" fetch -q --depth 1 origin "${COMMIT}"
git -C "${DEST}" checkout -q FETCH_HEAD

echo "==> Code-OSS fixado em upstream/stable.json"
cp "${ROOT}/upstream/stable.json" "${DEST}/upstream/stable.json"

echo "==> Ícones e imagens da marca"
cp -R "${ROOT}/branding/resources/stable/." "${DEST}/src/stable/"

echo "==> product.json"
# O prepare_vscode.sh do VSCodium aplica o product.json dele por último, então
# mesclar o nosso nele faz a identidade da FaKL-Code prevalecer.
jq -s '.[0] * .[1]' "${DEST}/product.json" "${ROOT}/branding/product.json" > "${DEST}/product.json.tmp"
mv "${DEST}/product.json.tmp" "${DEST}/product.json"

echo "==> Textos com o nome do VSCodium fora do product.json"
# Autor no package.json, nome do PWA do servidor, copyright do Electron e
# editora do instalador do Windows.
sed -i.bak \
  -e 's#|VSCodium|#|FaKL-Code|#g' \
  -e 's# VSCodium|# FaKL-Code|#g' \
  -e 's#"name" "VSCodium"#"name" "FaKL-Code"#' \
  -e 's#"short_name" "VSCodium"#"short_name" "FaKL-Code"#' \
  -e 's#https://vscodium.com#https://github.com/FaKL-Code/FaKL-Code-IDE#g' \
  "${DEST}/prepare_vscode.sh"
rm -f "${DEST}/prepare_vscode.sh.bak"

echo "==> Instalação de dependências"
# FAKL_NPM_CI troca o npm ci por outro comando: no CI, quando as node_modules
# vieram do cache, npm install só ajusta o que mudou em vez de apagar tudo.
grep -q 'npm ci && break' "${DEST}/prepare_vscode.sh"
# shellcheck disable=SC2016 # a expansão é no prepare_vscode.sh, não aqui
sed -i.bak 's#npm ci && break#${FAKL_NPM_CI:-npm ci} \&\& break#' "${DEST}/prepare_vscode.sh"
rm -f "${DEST}/prepare_vscode.sh.bak"

echo "==> Extensões embutidas"
# O prepare_vscode.sh do VSCodium copia src/stable/ para dentro do vscode/, então
# cada extensão vira vscode/extensions/<nome> e entra no build como as nativas.
# Elas vão já empacotadas (dist/, mais os ícones em media/ e os temas em
# themes/) e sem dependências, porque o build do VS Code não instala
# node_modules para extensões que ele não conhece.
(cd "${ROOT}" && pnpm install --frozen-lockfile && pnpm build)
for manifest in "${ROOT}"/extensions/*/package.json; do
  extension="$(dirname "${manifest}")"
  name="$(basename "${extension}")"
  target="${DEST}/src/stable/extensions/${name}"
  echo "    ${name}"
  rm -rf "${target}"
  mkdir -p "${target}"
  jq 'del(.scripts, .devDependencies, .dependencies)' "${manifest}" > "${target}/package.json"
  cp -R "${extension}/dist" "${target}/dist"
  for folder in media themes; do
    if [[ -d "${extension}/${folder}" ]]; then
      cp -R "${extension}/${folder}" "${target}/${folder}"
    fi
  done
  for file in README.md LICENSE package.nls.json package.nls.pt-br.json; do
    if [[ -f "${extension}/${file}" ]]; then
      cp "${extension}/${file}" "${target}/${file}"
    fi
  done
done

echo "==> Pacote de idioma pt-BR"
# A IDE abre em português quando o sistema está em português e em inglês nos
# outros casos (ADR 0036). O pacote vem do Open VSX na versão e com o SHA-256
# fixados em upstream/ e entra como extensão nativa, como as de cima.
PACK="${ROOT}/upstream/language-pack-pt-br.json"
PACK_ID="$(jq -r '.id' "${PACK}")"
PACK_VERSION="$(jq -r '.version' "${PACK}")"
PACK_SHA256="$(jq -r '.sha256' "${PACK}")"
DOWNLOADS="${WORK}/downloads"
VSIX="${DOWNLOADS}/${PACK_ID}-${PACK_VERSION}.vsix"
sha256() {
  if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}
mkdir -p "${DOWNLOADS}"
if [[ ! -f "${VSIX}" || "$(sha256 "${VSIX}")" != "${PACK_SHA256}" ]]; then
  curl --silent --show-error --fail --location --retry 3 --output "${VSIX}" "$(jq -r '.url' "${PACK}")"
fi
actual="$(sha256 "${VSIX}")"
if [[ "${actual}" != "${PACK_SHA256}" ]]; then
  rm -f "${VSIX}"
  echo "SHA-256 do ${PACK_ID} ${PACK_VERSION} não confere: ${actual}, esperado ${PACK_SHA256}" >&2
  exit 1
fi
target="${DEST}/src/stable/extensions/${PACK_ID#*.}"
echo "    ${PACK_ID#*.} ${PACK_VERSION}"
rm -rf "${target}" "${DOWNLOADS}/vsix"
unzip -q "${VSIX}" -d "${DOWNLOADS}/vsix"
mkdir -p "${target}"
cp -R "${DOWNLOADS}/vsix/extension/." "${target}/"
rm -rf "${DOWNLOADS}/vsix"
# O .vsix não traz a licença que o package.json cita ("LICENSE.md").
cp "${ROOT}/upstream/language-pack-pt-br.LICENSE.md" "${target}/LICENSE.md"

echo "==> Patches da FaKL-Code"
mkdir -p "${DEST}/patches/user"
shopt -s nullglob
for patch in "${ROOT}"/patches/*.patch; do
  echo "    $(basename "${patch}")"
  cp "${patch}" "${DEST}/patches/user/"
done

echo "==> Pronto"

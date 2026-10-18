#!/usr/bin/env bash
# Confere, sem compilar, que a árvore montada por build/prepare.sh carrega a
# identidade da FaKL-Code. Roda no CI a cada PR (barato) para pegar regressões
# antes do build completo, que é caro e só roda sob demanda.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${FAKL_BUILD_DIR:-${ROOT}/.build}/vscodium"
failures=0

fail() {
  echo "ERRO: $*" >&2
  failures=$((failures + 1))
}

expect_product() {
  local key="$1" expected
  expected="$(jq -r ".${key}" "${ROOT}/branding/product.json")"
  local actual
  actual="$(jq -r ".${key}" "${DEST}/product.json")"
  [[ "${actual}" == "${expected}" ]] || fail "product.json ${key}: '${actual}', esperado '${expected}'"
}

for key in nameShort nameLong applicationName dataFolderName urlProtocol darwinBundleIdentifier \
  win32AppId win32x64AppId win32UserAppId win32x64UserAppId win32DirName win32MutexName   updateUrl downloadUrl; do
  expect_product "${key}"
done

[[ "$(jq -r '.extensionsGallery.serviceUrl // empty' "${DEST}/product.json")" == "" ]] \
  || fail "product.json não deve fixar a galeria; o VSCodium já aponta para o Open VSX"
grep -q 'open-vsx.org/vscode/gallery' "${DEST}/prepare_vscode.sh" \
  || fail "o VSCodium não aponta mais para o Open VSX (RF-002)"

while IFS= read -r -d '' file; do
  relative="${file#"${ROOT}/branding/resources/stable/"}"
  cmp -s "${file}" "${DEST}/src/stable/${relative}" || fail "ícone não aplicado: ${relative}"
done < <(find "${ROOT}/branding/resources/stable" -type f -print0)

# A atualização aponta para os manifestos da FaKL-Code, nunca para os do VSCodium, e
# o env.sh não a desliga (ADR 0037).
jq -e '(.updateUrl | startswith("https://raw.githubusercontent.com/FaKL-Code/"))
  and (.downloadUrl | contains("VSCodium") | not)' "${DEST}/product.json" >/dev/null \
  || fail "product.json: updateUrl ou downloadUrl fora da FaKL-Code (ADR 0037)"
grep -q 'DISABLE_UPDATE:-no' "${ROOT}/build/env.sh" \
  || fail "build/env.sh deve deixar a atualização automática ligada (DISABLE_UPDATE:-no)"

grep -q 'rm -rf node_modules/@parcel/watcher-linux-\*-musl' "${DEST}/prepare_vscode.sh"   || fail "prepare_vscode.sh sem a remoção dos binários musl do @parcel/watcher (.deb do Linux)"

if grep -nE '"(short_)?name" "VSCodium"|\|VSCodium\||https://vscodium\.com' "${DEST}/prepare_vscode.sh"; then
  fail "prepare_vscode.sh ainda escreve o nome ou o site do VSCodium"
fi

[[ "$(jq -r '.tag' "${DEST}/upstream/stable.json")" == "$(jq -r '.tag' "${ROOT}/upstream/stable.json")" ]] \
  || fail "upstream/stable.json não foi aplicado"

for manifest in "${ROOT}"/extensions/*/package.json; do
  name="$(basename "$(dirname "${manifest}")")"
  target="${DEST}/src/stable/extensions/${name}"
  main="$(jq -r '.main' "${manifest}")"
  [[ -f "${target}/${main#./}" ]] || fail "extensão embutida ${name} sem ${main}"
  [[ "$(jq -r '.devDependencies // empty' "${target}/package.json")" == "" ]] \
    || fail "extensão embutida ${name} ainda declara devDependencies"
done

pack="${ROOT}/upstream/language-pack-pt-br.json"
pack_name="$(jq -r '.id' "${pack}")"
pack_dir="${DEST}/src/stable/extensions/${pack_name#*.}"
pack_version="$(jq -r '.version' "${pack}")"
if [[ ! -f "${pack_dir}/package.json" ]]; then
  fail "pacote de idioma pt-BR fora da árvore de build (${pack_dir})"
else
  [[ "$(jq -r '.version' "${pack_dir}/package.json")" == "${pack_version}" ]] \
    || fail "pacote de idioma pt-BR em outra versão; esperado ${pack_version}"
  [[ "$(jq -r '.contributes.localizations[0].languageId' "${pack_dir}/package.json")" == "pt-br" ]] \
    || fail "pacote de idioma não contribui o pt-br"
  [[ -f "${pack_dir}/translations/main.i18n.json" ]] || fail "pacote de idioma pt-BR sem as traduções do VS Code"
  [[ -f "${pack_dir}/LICENSE.md" ]] || fail "pacote de idioma pt-BR sem a licença"
fi
[[ -f "${DEST}/patches/user/fakl-idioma-do-sistema.patch" ]] \
  || fail "patch do idioma do sistema não copiado para patches/user"

if ((failures > 0)); then
  echo "${failures} problema(s) na marca." >&2
  exit 1
fi
echo "Marca FaKL-Code conferida."

#!/usr/bin/env bash
# Identidade da FaKL-Code usada pelos scripts do VSCodium (utils.sh e patches).
# Carregado por build/build.sh; também pode ser usado num build local.

export APP_NAME="FaKL-Code"
export BINARY_NAME="fakl-code"
export ORG_NAME="FaKL-Code"
export GH_REPO_PATH="FaKL-Code/FaKL-Code-IDE"
export ASSETS_REPOSITORY="FaKL-Code/FaKL-Code-IDE"
export GLOBAL_DIRNAME="fakl-code"
export VSCODE_QUALITY="stable"

# Atualização automática (RF-003, ADR 0037): o updateUrl da FaKL-Code, no
# branding/product.json, aponta para os manifestos que a release publica. Com
# DISABLE_UPDATE=yes o VSCodium aplicaria um patch que desliga o serviço de vez.
export DISABLE_UPDATE="${DISABLE_UPDATE:-no}"

# Artefatos que ainda não usamos. O servidor remoto (REH) volta no M3 (RF-304).
export SHOULD_BUILD_CLI="${SHOULD_BUILD_CLI:-no}"
export SHOULD_BUILD_REH="${SHOULD_BUILD_REH:-no}"
export SHOULD_BUILD_REH_WEB="${SHOULD_BUILD_REH_WEB:-no}"
export SHOULD_BUILD_MSI="${SHOULD_BUILD_MSI:-no}"
export SHOULD_BUILD_MSI_NOUP="${SHOULD_BUILD_MSI_NOUP:-no}"
export SHOULD_BUILD_SRC="${SHOULD_BUILD_SRC:-no}"

# Install files with Node.js. Run worker supervision inside WSL on Windows.
& node (Join-Path $PSScriptRoot 'install.mjs') @args
exit $LASTEXITCODE

$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'credentials.ps1')
    $token = Read-MonoToken
    [Console]::Out.Write($token)
    $token = $null
} catch {
    # Do not print exception objects, request headers, token or bank responses.
    [Console]::Error.Write('Token unavailable.')
    exit 1
}

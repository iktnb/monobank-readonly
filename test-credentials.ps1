$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credentials.ps1')
$testDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('mono-credential-test-' + [Guid]::NewGuid().ToString('N'))
try {
    $dummy = 'test-only-' + [Guid]::NewGuid().ToString('N')
    Initialize-MonoPrivateDirectory -Directory $testDirectory
    Save-MonoToken -Token $dummy -Directory $testDirectory
    if ((Read-MonoToken -Directory $testDirectory) -cne $dummy) { throw 'DPAPI round-trip failed.' }
    $dummy = 'replacement-test-only-' + [Guid]::NewGuid().ToString('N')
    Save-MonoToken -Token $dummy -Directory $testDirectory
    if ((Read-MonoToken -Directory $testDirectory) -cne $dummy) { throw 'DPAPI replacement failed.' }
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $testDirectory 'token.dpapi'))
    if ([System.Text.Encoding]::UTF8.GetString($bytes).Contains($dummy)) { throw 'Plaintext found in encrypted file.' }
    $acl = Get-Acl -LiteralPath $testDirectory
    if (-not $acl.AreAccessRulesProtected -or $acl.Access.Count -ne 1) { throw 'Unexpected ACL.' }
    [Console]::WriteLine('Save and replace in pre-restricted folder, DPAPI round-trip, ciphertext and current-user ACL: PASS (synthetic tokens only).')
} finally {
    $expectedParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
    $resolved = [System.IO.Path]::GetFullPath($testDirectory)
    if ([System.IO.Path]::GetDirectoryName($resolved) -eq $expectedParent -and [System.IO.Path]::GetFileName($resolved).StartsWith('mono-credential-test-')) {
        if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
}

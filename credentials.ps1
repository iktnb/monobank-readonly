Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

function Get-MonoPrivateDirectory {
    return (Join-Path $env:LOCALAPPDATA 'CodexMonobank\private')
}

function Initialize-MonoPrivateDirectory {
    param([string]$Directory = (Get-MonoPrivateDirectory))
    [System.IO.Directory]::CreateDirectory($Directory) | Out-Null
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    # Change only the DACL. Setting an owner on an already restricted folder can
    # require a privilege that a normal Windows session does not hold.
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    [System.IO.Directory]::SetAccessControl($Directory, $acl)
}

function Save-MonoToken {
    param([Parameter(Mandatory=$true)][string]$Token, [string]$Directory = (Get-MonoPrivateDirectory))
    if ($Token -cnotmatch '^[A-Za-z0-9._~+/=-]{20,2048}$') { throw 'Invalid token format.' }
    $clearBytes = $null
    $temporary = $null
    $stage = 'PERMISSIONS'
    try {
        Initialize-MonoPrivateDirectory -Directory $Directory
        $stage = 'ENCRYPTION'
        $clearBytes = [System.Text.Encoding]::UTF8.GetBytes($Token)
        $encrypted = [System.Security.Cryptography.ProtectedData]::Protect($clearBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        $stage = 'WRITE'
        $temporary = Join-Path $Directory ([Guid]::NewGuid().ToString('N') + '.tmp')
        [System.IO.File]::WriteAllBytes($temporary, $encrypted)
        $destination = Join-Path $Directory 'token.dpapi'
        Move-Item -LiteralPath $temporary -Destination $destination -Force
    } catch {
        # Return only a fixed diagnostic code, never the token or raw exception.
        throw [System.IO.IOException]::new('MONO_STORE_' + $stage)
    } finally {
        if ($null -ne $clearBytes) { [Array]::Clear($clearBytes, 0, $clearBytes.Length) }
        if ($temporary -and [System.IO.File]::Exists($temporary)) {
            [System.IO.File]::Delete($temporary)
        }
    }
}

function Read-MonoToken {
    param([string]$Directory = (Get-MonoPrivateDirectory))
    $encrypted = [System.IO.File]::ReadAllBytes((Join-Path $Directory 'token.dpapi'))
    $clearBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { return [System.Text.Encoding]::UTF8.GetString($clearBytes) }
    finally { [Array]::Clear($clearBytes, 0, $clearBytes.Length) }
}

param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credentials.ps1')
$monoStoreDirectory = if ($SelfTest) {
    Join-Path ([System.IO.Path]::GetTempPath()) ('mono-form-test-' + [Guid]::NewGuid().ToString('N'))
} else { Get-MonoPrivateDirectory }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Monobank - локальний токен'
$form.ClientSize = New-Object System.Drawing.Size(590, 385)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.AutoScaleMode = 'Dpi'

$heading = New-Object System.Windows.Forms.Label
$heading.Text = 'Доступ до monobank лише для читання'
$heading.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$heading.Location = New-Object System.Drawing.Point(24, 20)
$heading.Size = New-Object System.Drawing.Size(545, 36)
$form.Controls.Add($heading)

$help = New-Object System.Windows.Forms.Label
$help.Text = "1. Отримай персональний токен на api.monobank.ua.`r`n2. Встав його в поле нижче та натисни «Зберегти».`r`nТокен шифрується для твого облікового запису Windows."
$help.Location = New-Object System.Drawing.Point(24, 68)
$help.Size = New-Object System.Drawing.Size(540, 78)
$form.Controls.Add($help)

$box = New-Object System.Windows.Forms.TextBox
$box.Location = New-Object System.Drawing.Point(24, 154)
$box.Size = New-Object System.Drawing.Size(540, 30)
$box.UseSystemPasswordChar = $true
$box.MaxLength = 2048
$box.ShortcutsEnabled = $true
$box.AccessibleName = 'Персональний API-токен monobank'
$form.Controls.Add($box)

$save = New-Object System.Windows.Forms.Button
$save.Text = 'Зберегти'
$save.Location = New-Object System.Drawing.Point(24, 200)
$save.Size = New-Object System.Drawing.Size(145, 36)
$form.Controls.Add($save)
$form.AcceptButton = $save

$remove = New-Object System.Windows.Forms.Button
$remove.Text = 'Видалити локальний токен'
$remove.Location = New-Object System.Drawing.Point(185, 200)
$remove.Size = New-Object System.Drawing.Size(237, 36)
$form.Controls.Add($remove)

$close = New-Object System.Windows.Forms.Button
$close.Text = 'Закрити'
$close.Location = New-Object System.Drawing.Point(438, 200)
$close.Size = New-Object System.Drawing.Size(126, 36)
$close.DialogResult = 'Cancel'
$form.Controls.Add($close)
$form.CancelButton = $close

$status = New-Object System.Windows.Forms.Label
$status.Location = New-Object System.Drawing.Point(24, 250)
$status.Size = New-Object System.Drawing.Size(540, 52)
$tokenPath = Join-Path $monoStoreDirectory 'token.dpapi'
$status.Text = if (Test-Path -LiteralPath $tokenPath) { 'Токен уже збережено. Можна замінити його новим.' } else { 'Токен ще не збережено.' }
$status.AccessibleName = 'Стан збереження токена'
$form.Controls.Add($status)

$privacy = New-Object System.Windows.Forms.Label
$privacy.Text = "Це вікно працює локально та не надсилає токен у чат.`r`nФінансові дані, запитані в чаті, передаватимуться OpenAI.`r`nПароль банку, PIN, CVV і коди підтвердження не потрібні."
$privacy.Location = New-Object System.Drawing.Point(24, 309)
$privacy.Size = New-Object System.Drawing.Size(545, 66)
$privacy.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$form.Controls.Add($privacy)

$save.Add_Click({
    $plain = $box.Text.Trim()
    try {
        if ($plain -cnotmatch '^[A-Za-z0-9._~+/=-]{20,2048}$') {
            $status.Text = 'Перевір токен: встав лише ключ із API-кабінету monobank.'
            $status.ForeColor = [System.Drawing.Color]::DarkRed
            $status.Tag = 'INVALID_FORMAT'
            return
        }
        Save-MonoToken -Token $plain -Directory $monoStoreDirectory
        # Clear only the clipboard content matching the pasted token.
        try {
            if (-not $SelfTest -and [System.Windows.Forms.Clipboard]::ContainsText() -and [System.Windows.Forms.Clipboard]::GetText().Trim() -ceq $plain) {
                [System.Windows.Forms.Clipboard]::Clear()
            }
        } catch { }
        $box.Clear()
        $status.Text = "Токен збережено зашифрованим. Вікно можна закрити.`r`nПідключення до банку перевіримо наступним запитом у чаті."
        $status.ForeColor = [System.Drawing.Color]::DarkGreen
        $status.Tag = 'SAVED'
    } catch {
        $code = $_.Exception.Message
        switch ($code) {
            'MONO_STORE_PERMISSIONS' { $status.Text = 'Не вдалося встановити захист папки. Код: MONO_STORE_PERMISSIONS.' }
            'MONO_STORE_ENCRYPTION' { $status.Text = 'Windows не змогла зашифрувати ключ. Код: MONO_STORE_ENCRYPTION.' }
            'MONO_STORE_WRITE' { $status.Text = 'Не вдалося записати зашифрований ключ. Код: MONO_STORE_WRITE.' }
            default { $code = 'MONO_STORE_UNKNOWN'; $status.Text = 'Не вдалося зберегти ключ. Код: MONO_STORE_UNKNOWN.' }
        }
        $status.Tag = $code
        $status.ForeColor = [System.Drawing.Color]::DarkRed
    } finally { $plain = $null }
})

$remove.Add_Click({
    try {
        if (Test-Path -LiteralPath $tokenPath) { Remove-Item -LiteralPath $tokenPath -Force }
        $box.Clear()
        $status.Text = "Локальний токен видалено. Нові запити будуть заблоковані.`r`nДля відкликання самого ключа скористайся кабінетом банку."
        $status.ForeColor = [System.Drawing.Color]::DarkGreen
        $status.Tag = 'REMOVED'
    } catch {
        $status.Text = 'Не вдалося видалити локальний токен.'
        $status.ForeColor = [System.Drawing.Color]::DarkRed
    }
})

$form.Add_Shown({ $form.Activate(); $box.Focus() })
$form.Add_FormClosed({ $box.Clear() })
if ($SelfTest) {
    try {
        if (-not $box.UseSystemPasswordChar -or $box.Text.Length -ne 0 -or $form.Controls.Count -ne 8) { throw 'Form check failed.' }
        # Match the installed state: the directory is already restricted before saving.
        Initialize-MonoPrivateDirectory -Directory $monoStoreDirectory
        $form.Opacity = 0
        $form.ShowInTaskbar = $false
        $form.Show()
        [System.Windows.Forms.Application]::DoEvents()
        foreach ($attempt in 1..2) {
            $dummy = 'synthetic-form-test-' + [Guid]::NewGuid().ToString('N')
            $box.Text = $dummy
            $save.PerformClick()
            if ($status.Tag -cne 'SAVED') { throw ('Button save failed: ' + $status.Tag) }
            if ((Read-MonoToken -Directory $monoStoreDirectory) -cne $dummy) { throw 'Button did not save the expected synthetic token.' }
            if ($box.Text.Length -ne 0) { throw 'Password field was not cleared.' }
        }
        $remove.PerformClick()
        if ($status.Tag -cne 'REMOVED' -or (Test-Path -LiteralPath $tokenPath)) { throw 'Button removal failed.' }
        $box.Text = 'invalid'
        $save.PerformClick()
        if ($status.Tag -cne 'INVALID_FORMAT' -or (Test-Path -LiteralPath $tokenPath)) { throw 'Invalid token validation failed.' }
        [Console]::WriteLine('Local token form: PASS (masked input, real button save/replace/remove, invalid input; synthetic tokens only).')
    } finally {
        $form.Close()
        $form.Dispose()
        $expectedParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
        $resolved = [System.IO.Path]::GetFullPath($monoStoreDirectory)
        if ([System.IO.Path]::GetDirectoryName($resolved) -eq $expectedParent -and [System.IO.Path]::GetFileName($resolved).StartsWith('mono-form-test-')) {
            if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
        }
    }
} else {
    [void]$form.ShowDialog()
    $form.Dispose()
}

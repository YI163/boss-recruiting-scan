# bsk-eval.ps1 —— 用 base64 包装 JS，避开 PowerShell 5.1 把参数里双引号吃掉的坑
# 用法: .\bsk-eval.ps1 -JsFile path\to\expr.js -Session gnvb -TabId 168938656 [-Pretty]
param(
  [Parameter(Mandatory = $true)][string]$JsFile,
  [Parameter(Mandatory = $true)][string]$Session,
  [string]$TabId = "",
  [switch]$Pretty
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$bsk = "C:\Users\<you>\AppData\Local\Programs\Python\Python313\Scripts\bsk.exe"
$js = [IO.File]::ReadAllText($JsFile, [Text.Encoding]::UTF8)
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))
$expr = 'eval(atob(`' + $b64 + '`))'
$args = @('evaluate', '--session', $Session, '--json', $expr)
if ($TabId -ne '') { $args += @('--tab-id', $TabId) }
$out = & $bsk @args 2>&1
if ($Pretty) { $out | ConvertFrom-Json | ConvertTo-Json -Depth 12 } else { $out }
exit $LASTEXITCODE

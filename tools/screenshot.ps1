# Captura la ventana de GCenter a un PNG, para poder revisar la interfaz.
# Usa PrintWindow con PW_RENDERFULLCONTENT, asi funciona aunque la ventana este
# tapada por otra o en segundo plano.
param([string]$Out = "$env:TEMP\gcenter-shot.png", [string]$TitleLike = "GCenter")

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  // Sin esto Windows nos da coordenadas logicas y el PNG sale recortado en
  // pantallas con escalado distinto del 100%
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rg, B; }
}
"@

[W]::SetProcessDPIAware() | Out-Null

# "electron" en desarrollo, "GCenter" cuando corre ya empaquetado
$proc = Get-Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ProcessName -in @("electron", "GCenter") -and
    $_.MainWindowHandle -ne 0 -and
    $_.MainWindowTitle -like "*$TitleLike*"
  } |
  Select-Object -First 1

if (-not $proc) { Write-Output "No encuentro ventana con titulo '$TitleLike'"; exit 1 }

$h = $proc.MainWindowHandle
if ([W]::IsIconic($h)) { [W]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 700 }

$r = New-Object W+R
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Rg - $r.L
$hh = $r.B - $r.T
if ($w -le 0 -or $hh -le 0) { Write-Output "Rect invalido"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[W]::PrintWindow($h, $hdc, 2) | Out-Null   # 2 = PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

Write-Output "Guardado: $Out  ($w x $hh)  ventana='$($proc.MainWindowTitle)'"

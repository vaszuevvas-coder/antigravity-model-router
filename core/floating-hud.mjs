/**
 * @file floating-hud.mjs
 * @description Native Always-on-Top Floating Pill Status Bar (HUD) for Windows.
 * Renders a frameless, draggable dark capsule in Google Antigravity style (#232530)
 * with a pulsing purple bloom indicator, smooth filling bloom progress line,
 * and automatic synchronization with core/task-progress.mjs.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJsonSync, safeReadJsonSync } from './safe-json.mjs';
import { normalizeLang, readActiveUiLanguage } from './i18n.mjs';
import {
  TASK_PROGRESS_FILE,
  getTaskProgressSnapshot,
  setExplicitTaskProgress,
} from './task-progress.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
const CACHE_DIR = join(PLUGIN_ROOT, '.cache');
export const HUD_RUNTIME_FILE = join(CACHE_DIR, 'floating-hud.json');
export const HUD_POSITION_FILE = join(CACHE_DIR, 'hud-position.json');
export const HUD_PS1_SCRIPT_FILE = join(CACHE_DIR, 'floating-hud-host.ps1');

function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

export { isPidAlive } from './cache-dir.mjs';

function isRunningUnderAutomatedTest() {
  if (process.env.NODE_TEST_CONTEXT) return true;
  return Array.isArray(process.argv) && process.argv.some((a) => String(a).includes('--test') || String(a).endsWith('.test.mjs'));
}

/**
 * Generates the Windows PowerShell WPF script with UTF-8 BOM for proper Cyrillic rendering.
 */
export function buildWpfFloatingHudScript(opts = {}) {
  const {
    progressFile = TASK_PROGRESS_FILE,
    runtimeFile = HUD_RUNTIME_FILE,
    positionFile = HUD_POSITION_FILE,
    lang = '',
  } = opts && typeof opts === 'object' ? opts : {};
  const esc = (p) => String(p).replace(/'/g, "''");
  let resolvedLangRaw = String(lang || '').trim().toLowerCase();
  if (resolvedLangRaw !== 'en' && resolvedLangRaw !== 'ru') {
    try {
      const st = safeReadJsonSync(join(PLUGIN_ROOT, 'router-state.json'), null, { selfHeal: false });
      if (!resolvedLangRaw) resolvedLangRaw = String(st?.uiLanguage || '').trim().toLowerCase();
    } catch {}
  }
  const hudLang = normalizeLang(resolvedLangRaw || readActiveUiLanguage(PLUGIN_ROOT), 'en');
  const isEnHud = hudLang === 'en';
  const palette = {
    outerBg: '#E81E202B',
    outerBorder: '#343746',
    shadowColor: '#000000',
    shadowOpacity: '0.68',
    innerBg: '#F5252734',
    innerBorder: '#45485C',
    stageFg: '#F3F4F6',
    trackBg: '#3A3D4E',
    percentFg: '#E5E7EB',
    glowGrad1: '#9F7AEA',
    glowGrad2: '#C4B5FD',
    glowShadow: '#A78BFA',
    accentCore: '#B794F4',
    accentHalo: '#66A78BFA',
  };
  return `\uFEFF# Antigravity Floating Pill Progress HUD (WPF TopMost Overlay)
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$ProgressFile = '${esc(progressFile)}'
$RuntimeFile  = '${esc(runtimeFile)}'
$PositionFile = '${esc(positionFile)}'

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Antigravity Progress HUD"
        Width="600" Height="78"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        Topmost="True"
        ShowInTaskbar="False"
        ShowActivated="False"
        ResizeMode="NoResize">
  <Grid Margin="14,12,14,14">
    <!-- Outer capsule frame matching Antigravity composer border -->
    <Border CornerRadius="23" Background="${palette.outerBg}" BorderBrush="${palette.outerBorder}" BorderThickness="1" Padding="4">
      <Border.Effect>
        <DropShadowEffect Color="${palette.shadowColor}" BlurRadius="22" ShadowDepth="4" Opacity="${palette.shadowOpacity}" />
      </Border.Effect>
      <!-- Inner pill surface -->
      <Border Name="InnerPill" CornerRadius="19" Background="${palette.innerBg}" BorderBrush="${palette.innerBorder}" BorderThickness="1" Padding="16,0,16,0">
        <Grid VerticalAlignment="Center" Height="38">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Name="ColDot" Width="28" />
            <ColumnDefinition Name="ColStage" Width="*" />
            <ColumnDefinition Name="ColTrack" Width="148" />
            <ColumnDefinition Name="ColPct" Width="46" />
          </Grid.ColumnDefinitions>

          <!-- 1. Left Pulsing Dot with Bloom -->
          <Grid Grid.Column="0" VerticalAlignment="Center" HorizontalAlignment="Left" Width="22" Height="22">
            <Ellipse Name="DotHalo" Width="20" Height="20" Fill="#55A78BFA" Opacity="0.65" HorizontalAlignment="Center" VerticalAlignment="Center">
              <Ellipse.Effect>
                <BlurEffect Radius="8" />
              </Ellipse.Effect>
            </Ellipse>
            <Ellipse Name="DotCore" Width="10" Height="10" Fill="#B794F4" HorizontalAlignment="Center" VerticalAlignment="Center">
              <Ellipse.Effect>
                <DropShadowEffect Color="#A78BFA" BlurRadius="14" ShadowDepth="0" Opacity="1.0" />
              </Ellipse.Effect>
            </Ellipse>
          </Grid>

          <!-- 2. Stage & Operation Text -->
          <TextBlock Name="StageText"
                     Grid.Column="1"
                     Text="${isEnHud ? 'Step 1 of 4 · Idle' : 'Этап 1 из 4 · Ожидание задачи'}"
                     Foreground="${palette.stageFg}"
                     FontFamily="Segoe UI Variable Display, Segoe UI"
                     FontSize="13"
                     FontWeight="SemiBold"
                     VerticalAlignment="Center"
                     Margin="2,0,14,1"
                     TextTrimming="CharacterEllipsis" />

          <!-- 3. Progress Bar Track & Bloom Fill Line -->
          <Grid Grid.Column="2" VerticalAlignment="Center" Height="14">
            <Border Name="ProgressTrackBg" Width="140" Height="5.5" CornerRadius="2.75" Background="${palette.trackBg}" HorizontalAlignment="Left" VerticalAlignment="Center" />
            <Border Name="ProgressGlowBar" Width="2" Height="6" CornerRadius="3" HorizontalAlignment="Left" VerticalAlignment="Center" Opacity="0.92">
              <Border.Background>
                <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
                  <GradientStop Color="${palette.glowGrad1}" Offset="0.0" />
                  <GradientStop Color="${palette.glowGrad2}" Offset="1.0" />
                </LinearGradientBrush>
              </Border.Background>
              <Border.Effect>
                <DropShadowEffect Color="${palette.glowShadow}" BlurRadius="13" ShadowDepth="0" Opacity="0.95" />
              </Border.Effect>
            </Border>
          </Grid>

          <!-- 4. Percentage Label -->
          <TextBlock Name="PercentText"
                     Grid.Column="3"
                     Text="0%"
                     Foreground="${palette.percentFg}"
                     FontFamily="Segoe UI Variable Display, Segoe UI"
                     FontSize="13"
                     FontWeight="SemiBold"
                     VerticalAlignment="Center"
                     TextAlignment="Right"
                     Margin="0,0,0,1" />
        </Grid>
      </Border>
    </Border>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)

$DotHalo         = $window.FindName("DotHalo")
$DotCore         = $window.FindName("DotCore")
$StageText       = $window.FindName("StageText")
$ProgressGlowBar = $window.FindName("ProgressGlowBar")
$PercentText     = $window.FindName("PercentText")
$InnerPill       = $window.FindName("InnerPill")
$ColDot          = $window.FindName("ColDot")
$ColStage        = $window.FindName("ColStage")
$ColTrack        = $window.FindName("ColTrack")
$ColPct          = $window.FindName("ColPct")
$ProgressTrackBg = $window.FindName("ProgressTrackBg")
$script:isCompact = $false

function Set-DefaultHudPosition {
  $workArea = [System.Windows.SystemParameters]::WorkArea
  $window.Left = [Math]::Round(($workArea.Width - $window.Width) / 2 + $workArea.Left)
  $window.Top  = [Math]::Round($workArea.Bottom - $window.Height - 118)
}

Set-DefaultHudPosition

if (Test-Path $PositionFile) {
  try {
    $posRaw = Get-Content -Path $PositionFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $posRaw.left -and $null -ne $posRaw.top) {
      $workArea = [System.Windows.SystemParameters]::WorkArea
      if ($posRaw.left -ge ($workArea.Left - 100) -and $posRaw.left -le ($workArea.Right - 80) -and
          $posRaw.top -ge ($workArea.Top - 40) -and $posRaw.top -le ($workArea.Bottom - 30)) {
        $window.Left = [double]$posRaw.left
        $window.Top  = [double]$posRaw.top
      }
    }
  } catch {}
}

function Save-HudPosition {
  try {
    $obj = @{ left = [Math]::Round($window.Left); top = [Math]::Round($window.Top); compact = [bool]$script:isCompact; updatedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
    $json = $obj | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($PositionFile, $json, [System.Text.Encoding]::UTF8)
  } catch {}
}

function Toggle-CompactHud {
  param([bool]$Save = $true)
  $script:isCompact = -not $script:isCompact
  if ($script:isCompact) {
    $window.Width = 156
    if ($InnerPill) { $InnerPill.Padding = New-Object System.Windows.Thickness(10, 0, 10, 0) }
    if ($ColDot) { $ColDot.Width = New-Object System.Windows.GridLength(24) }
    if ($ColStage) { $ColStage.Width = New-Object System.Windows.GridLength(0) }
    if ($StageText) { $StageText.Visibility = [System.Windows.Visibility]::Collapsed }
    if ($ColTrack) { $ColTrack.Width = New-Object System.Windows.GridLength(42) }
    if ($ProgressTrackBg) { $ProgressTrackBg.Width = 38 }
    if ($ColPct) { $ColPct.Width = New-Object System.Windows.GridLength(38) }
    if ($miCompact) { $miCompact.Header = "${isEnHud ? 'Expand status bar (600px)' : 'Развернуть статус-бар (600px)'}" }
  } else {
    $window.Width = 600
    if ($InnerPill) { $InnerPill.Padding = New-Object System.Windows.Thickness(16, 0, 16, 0) }
    if ($ColDot) { $ColDot.Width = New-Object System.Windows.GridLength(28) }
    if ($ColStage) { $ColStage.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star) }
    if ($StageText) { $StageText.Visibility = [System.Windows.Visibility]::Visible }
    if ($ColTrack) { $ColTrack.Width = New-Object System.Windows.GridLength(148) }
    if ($ProgressTrackBg) { $ProgressTrackBg.Width = 140 }
    if ($ColPct) { $ColPct.Width = New-Object System.Windows.GridLength(46) }
    if ($miCompact) { $miCompact.Header = "${isEnHud ? 'Collapse to mini mode (156px)' : 'Свернуть в мини-режим (156px)'}" }
  }
  if ($Save) { Save-HudPosition }
}

$window.Add_MouseLeftButtonDown({
  param($sender, $e)
  try {
    if ($e -and $e.ClickCount -eq 2) {
      Toggle-CompactHud
      return
    }
    $window.DragMove()
    Save-HudPosition
  } catch {}
})

# Context Menu (Right Click)
$ctxMenu = New-Object System.Windows.Controls.ContextMenu
$miCompact = New-Object System.Windows.Controls.MenuItem
$miCompact.Header = "${isEnHud ? 'Collapse to mini mode (156px)' : 'Свернуть в мини-режим (156px)'}"
$miCompact.Add_Click({
  Toggle-CompactHud
})

$miResetPos = New-Object System.Windows.Controls.MenuItem
$miResetPos.Header = "${isEnHud ? 'Reset position above chat input' : 'Вернуть позицию над полем ввода чата'}"
$miResetPos.Add_Click({
  Set-DefaultHudPosition
  Save-HudPosition
})

$miClose = New-Object System.Windows.Controls.MenuItem
$miClose.Header = "${isEnHud ? 'Hide floating status bar' : 'Скрыть плавающий статус-бар'}"
$miClose.Add_Click({
  try {
    $stopObj = @{ enabled = $false; stopRequested = $true; pid = 0; updatedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
    [System.IO.File]::WriteAllText($RuntimeFile, ($stopObj | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)
  } catch {}
  $window.Close()
})

$ctxMenu.Items.Add($miCompact) | Out-Null
$ctxMenu.Items.Add($miResetPos) | Out-Null
$ctxMenu.Items.Add($miClose) | Out-Null
$window.ContextMenu = $ctxMenu

if ($posRaw -and $posRaw.compact -eq $true) {
  $script:isCompact = $false
  Toggle-CompactHud -Save $false
}

$script:targetPct  = 0.0
$script:currentPct = 0.0
$script:tickCount  = 0
$script:statusMode = "idle"
$script:lastMtime  = [datetime]::MinValue

$brushPurpleCore = [System.Windows.Media.SolidColorBrush]([System.Windows.Media.ColorConverter]::ConvertFromString("${palette.accentCore}"))
$brushPurpleHalo = [System.Windows.Media.SolidColorBrush]([System.Windows.Media.ColorConverter]::ConvertFromString("${palette.accentHalo}"))
$brushGreenCore  = [System.Windows.Media.SolidColorBrush]([System.Windows.Media.ColorConverter]::ConvertFromString("#34D399"))
$brushGreenHalo  = [System.Windows.Media.SolidColorBrush]([System.Windows.Media.ColorConverter]::ConvertFromString("#5510B981"))
$brushErrCore    = [System.Windows.Media.SolidColorBrush]([System.Windows.Media.ColorConverter]::ConvertFromString("#F87171"))
$brushErrHalo    = [System.Windows.Media.SolidColorBrush]([System.Windows.Media.ColorConverter]::ConvertFromString("#55EF4444"))

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(40)
$timer.Add_Tick({
  $script:tickCount++

  # 1. Smooth 25fps Bloom Breathing Animation on Left Dot
  $phase = [Math]::Sin($script:tickCount * 0.14)
  if ($script:statusMode -eq "running") {
    $DotHalo.Opacity = 0.58 + ($phase * 0.34)
    $DotCore.Opacity = 0.88 + ($phase * 0.12)
  } elseif ($script:statusMode -eq "completed") {
    $DotHalo.Opacity = 0.45 + ($phase * 0.15)
    $DotCore.Opacity = 0.96
  } else {
    $DotHalo.Opacity = 0.30 + ($phase * 0.15)
    $DotCore.Opacity = 0.78
  }

  # 2. Smooth Cubic Interpolation of Progress Bar Width & Percentage
  $diff = $script:targetPct - $script:currentPct
  if ([Math]::Abs($diff) -gt 0.15) {
    $script:currentPct = $script:currentPct + ($diff * 0.22)
  } else {
    $script:currentPct = $script:targetPct
  }
  $clampedPct = [Math]::Max(0.0, [Math]::Min(100.0, $script:currentPct))
  $maxBar     = if ($script:isCompact) { 38.0 } else { 140.0 }
  $barWidth   = [Math]::Max(3.0, [Math]::Round(($clampedPct / 100.0) * $maxBar, 1))
  $ProgressGlowBar.Width = $barWidth
  $PercentText.Text = "$([Math]::Round($clampedPct))%"

  # 3. Poll progress JSON & runtime stop flag every ~200ms (every 5 ticks)
  if (($script:tickCount % 5) -eq 0) {
    if (Test-Path $RuntimeFile) {
      try {
        $rt = Get-Content -Path $RuntimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($rt.stopRequested -eq $true -or $rt.enabled -eq $false) {
          $timer.Stop()
          $window.Close()
          return
        }
      } catch {}
    }

    if (Test-Path $ProgressFile) {
      try {
        $item = Get-Item $ProgressFile -ErrorAction SilentlyContinue
        if ($null -ne $item -and $item.LastWriteTimeUtc -ne $script:lastMtime) {
          $script:lastMtime = $item.LastWriteTimeUtc
          $p = Get-Content -Path $ProgressFile -Raw -Encoding UTF8 | ConvertFrom-Json
          if ($null -ne $p) {
            $script:targetPct = [double]($p.percent)
            if ($p.formattedText) {
              $StageText.Text = [string]$p.formattedText
            }
            $st = [string]$p.status
            $script:statusMode = $st
            if ($st -eq "completed") {
              $DotCore.Fill = $brushGreenCore
              $DotHalo.Fill = $brushGreenHalo
            } elseif ($st -eq "error") {
              $DotCore.Fill = $brushErrCore
              $DotHalo.Fill = $brushErrHalo
            } else {
              $DotCore.Fill = $brushPurpleCore
              $DotHalo.Fill = $brushPurpleHalo
            }
          }
        }
      } catch {}
    }
  }
})

$timer.Start()
$window.Add_Closed({
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvokeShutdown([System.Windows.Threading.DispatcherPriority]::Background)
})
$window.Show()
[System.Windows.Threading.Dispatcher]::Run()
`;
}

/**
 * Reads the current status of the Floating HUD overlay.
 */
export function getFloatingHudStatus() {
  ensureCacheDir();
  const rt = safeReadJsonSync(HUD_RUNTIME_FILE, () => ({
    enabled: true,
    stopRequested: false,
    pid: 0,
    updatedAt: 0,
  }));
  const pos = safeReadJsonSync(HUD_POSITION_FILE, () => null);
  const progress = getTaskProgressSnapshot();
  const pid = Number(rt?.pid || 0);
  const running = pid > 0 && isPidAlive(pid);

  return {
    supported: process.platform === 'win32',
    enabled: rt?.enabled !== false,
    running,
    pid: running ? pid : 0,
    position: pos,
    progress,
  };
}

/**
 * Ensures the Floating HUD overlay process is running on Windows if enabled.
 */
export function ensureFloatingHudRunning({
  forceRestart = false,
  allowInTests = false,
  state = null,
} = {}) {
  if (state?.floatingHudEnabled === false) {
    stopFloatingHud();
    return { ok: true, supported: true, running: false, disabledByState: true };
  }
  ensureCacheDir();
  if (process.platform !== 'win32') {
    return { ok: false, supported: false, running: false, reason: 'Windows WPF required' };
  }
  if (isRunningUnderAutomatedTest() && !allowInTests) {
    return { ok: true, supported: true, running: false, skippedInTest: true };
  }

  const current = getFloatingHudStatus();
  if (current.running && !forceRestart) {
    return { ok: true, supported: true, running: true, pid: current.pid, reused: true };
  }

  if (current.running && forceRestart) {
    stopFloatingHud();
  }

  try {
    if (!existsSync(TASK_PROGRESS_FILE)) {
      getTaskProgressSnapshot();
    }
    const ps1Content = buildWpfFloatingHudScript({ lang: state?.uiLanguage || '' });
    writeFileSync(HUD_PS1_SCRIPT_FILE, ps1Content, 'utf8');

    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Sta',
        '-File',
        HUD_PS1_SCRIPT_FILE,
      ],
      {
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      }
    );
    if (typeof child.unref === 'function') {
      child.unref();
    }
    const pid = Number(child.pid || 0);

    atomicWriteJsonSync(HUD_RUNTIME_FILE, {
      enabled: true,
      stopRequested: false,
      pid,
      updatedAt: Date.now(),
    });

    return { ok: true, supported: true, running: pid > 0, pid, reused: false };
  } catch (err) {
    return { ok: false, supported: true, running: false, error: err.message };
  }
}

/**
 * Stops the Floating HUD overlay process cleanly.
 */
export function stopFloatingHud() {
  ensureCacheDir();
  const rt = safeReadJsonSync(HUD_RUNTIME_FILE, () => ({ pid: 0 }));
  const pid = Number(rt?.pid || 0);

  atomicWriteJsonSync(HUD_RUNTIME_FILE, {
    enabled: false,
    stopRequested: true,
    pid: 0,
    updatedAt: Date.now(),
  });

  if (pid > 0 && isPidAlive(pid)) {
    try {
      process.kill(pid);
    } catch {}
  }

  return { ok: true, running: false, stoppedPid: pid };
}

/**
 * Resets saved HUD coordinates back to the default position above the chat input box.
 */
export function resetFloatingHudPosition() {
  ensureCacheDir();
  atomicWriteJsonSync(HUD_POSITION_FILE, { left: null, top: null, resetAt: Date.now() });
  const st = getFloatingHudStatus();
  if (st.running) {
    return ensureFloatingHudRunning({ forceRestart: true });
  }
  return { ok: true, reset: true };
}

/**
 * Runs a smooth 4-stage demo animation across the status bar so the user can preview the bloom & step transitions.
 */
export function runFloatingHudDemo({ stepIntervalMs = 850, lang = '' } = {}) {
  const isEn = normalizeLang(lang || readActiveUiLanguage(PLUGIN_ROOT), 'en') === 'en';
  const demoSteps = isEn
    ? [
        'Analyzing context and dependencies',
        'Editing server.mjs',
        'Checking contracts (Blast Radius)',
        'Final testing',
      ]
    : [
        'Анализ контекста и зависимостей',
        'Правка server.mjs',
        'Контроль контрактов (Blast Radius)',
        'Финальное тестирование',
      ];

  setExplicitTaskProgress({
    currentStep: 1,
    totalSteps: 4,
    percent: 25,
    stepTitle: demoSteps[0],
    status: 'running',
    steps: demoSteps,
  });

  const scheduleStep = (delayMs, fn) => {
    const t = setTimeout(fn, delayMs);
    if (typeof t.unref === 'function') t.unref();
  };

  scheduleStep(stepIntervalMs, () => {
    setExplicitTaskProgress({
      currentStep: 2,
      totalSteps: 4,
      percent: 50,
      stepTitle: demoSteps[1],
      status: 'running',
      steps: demoSteps,
    });
    setExplicitTaskProgress({
      conversationId: 'demo-sub-1',
      parentConversationId: 'default',
      isSubagent: true,
      roleLabel: isEn ? 'Context Scout' : 'Разведка контекста',
      currentStep: 1,
      totalSteps: 3,
      percent: 42,
      stepTitle: isEn ? 'Reading router-core.mjs' : 'Чтение router-core.mjs',
      status: 'running',
    });
    setExplicitTaskProgress({
      conversationId: 'demo-sub-2',
      parentConversationId: 'default',
      isSubagent: true,
      roleLabel: isEn ? 'Contract Audit' : 'Аудит связей',
      currentStep: 2,
      totalSteps: 3,
      percent: 68,
      stepTitle: isEn ? 'Checking UI contracts' : 'Сверка контрактов UI',
      status: 'running',
    });
  });

  scheduleStep(stepIntervalMs * 2, () => {
    setExplicitTaskProgress({
      currentStep: 3,
      totalSteps: 4,
      percent: 75,
      stepTitle: demoSteps[2],
      status: 'running',
      steps: demoSteps,
    });
    setExplicitTaskProgress({
      conversationId: 'demo-sub-1',
      parentConversationId: 'default',
      isSubagent: true,
      roleLabel: isEn ? 'Context Scout' : 'Разведка контекста',
      currentStep: 3,
      totalSteps: 3,
      percent: 100,
      stepTitle: isEn ? 'Completed ✓' : 'Завершено ✓',
      status: 'completed',
    });
    setExplicitTaskProgress({
      conversationId: 'demo-sub-2',
      parentConversationId: 'default',
      isSubagent: true,
      roleLabel: isEn ? 'Contract Audit' : 'Аудит связей',
      currentStep: 3,
      totalSteps: 3,
      percent: 88,
      stepTitle: isEn ? 'Final verification' : 'Финальная проверка',
      status: 'running',
    });
  });

  scheduleStep(stepIntervalMs * 3, () => {
    setExplicitTaskProgress({
      conversationId: 'demo-sub-2',
      parentConversationId: 'default',
      isSubagent: true,
      roleLabel: isEn ? 'Contract Audit' : 'Аудит связей',
      currentStep: 3,
      totalSteps: 3,
      percent: 100,
      stepTitle: isEn ? 'Completed ✓' : 'Завершено ✓',
      status: 'completed',
    });
    setExplicitTaskProgress({
      currentStep: 4,
      totalSteps: 4,
      percent: 100,
      stepTitle: demoSteps[3],
      status: 'completed',
      steps: demoSteps,
    });
  });

  return getTaskProgressSnapshot();
}

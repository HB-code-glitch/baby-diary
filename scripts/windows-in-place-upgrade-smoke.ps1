param(
  [Parameter(Mandatory = $true)]
  [string]$BaselineSetupPath,
  [Parameter(Mandatory = $true)]
  [string]$CandidateSetupPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedPublisher,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedCertificateSha256,
  [string]$ExpectedBaselineVersion = '0.3.8',
  [string]$ExpectedCandidateVersion = '0.3.9',
  [Parameter(Mandatory = $true)]
  [string]$CandidateSourceSha,
  [Parameter(Mandatory = $true)]
  [string]$CandidatePackageSha256,
  [Parameter(Mandatory = $true)]
  [string]$CandidateProvenancePath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedRepository,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedWorkflowRunId,
  [ValidateSet(
    'none',
    'after-baseline-close',
    'after-manifest-creation',
    'before-candidate-replacement',
    'during-candidate-replacement',
    'after-candidate-replacement',
    'before-candidate-first-launch'
  )]
  [string]$FailurePoint = 'none'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BaselineReleaseId = 352876543
$BaselineAssetId = 474870034
$BaselineAssetName = 'Baby-Diary-Setup-0.3.8.exe'
$BaselineAssetSize = 233249330
$BaselineAssetSha256 = 'edb3a3e2d036f0d16dc8d75948c3f160c35adc9d1277a3dedc41d8671bd6a6de'
$BaselineSourceSha = '4ad44829c0de56da33d9123c16f92e6090f0df4a'
$ExpectedAppId = 'com.family.babydiary'
$ExpectedProductName = 'Baby Diary'
$ExpectedInstallChannelArgument = '/currentuser'
# UUIDv5(ExpectedAppId, electron-builder NSIS namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3).
$ExpectedRegistryChildName = 'e6d921f5-ef98-5cc5-a617-ae4251276f45'
$ExpectedBaselineDisplayName = "$ExpectedProductName $ExpectedBaselineVersion"
$ExpectedCandidateDisplayName = $ExpectedProductName
$ExpectedCandidateRegistryPublisher = 'HB-code-glitch'
$ExpectedBaselineShortcutName = -join @(
  [char]0xBCA0, [char]0xC774, [char]0xBE44, [char]0x20,
  [char]0xB2E4, [char]0xC774, [char]0xC5B4, [char]0xB9AC
)
$ExpectedCandidateShortcutName = $ExpectedProductName
$SetupTimeoutSeconds = 300
$DriverTimeoutSeconds = 180
$NpmTimeoutSeconds = 600
$UninstallTimeoutSeconds = 180
$ProcessCleanupTimeoutSeconds = 15

$repoRoot = Split-Path -Parent $PSScriptRoot
$upgradeDriver = Join-Path $PSScriptRoot 'upgrade-e2e.mjs'
$dataContract = Join-Path $PSScriptRoot 'upgrade-data-contract.mjs'
$runId = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path ([IO.Path]::GetTempPath()) "baby-diary-upgrade-$runId"
$isolatedAppData = Join-Path $runRoot 'AppData\Roaming'
$canonicalProfile = Join-Path $isolatedAppData 'baby-diary'
$baselineProjection = Join-Path $runRoot 'baseline-projection.json'
$firstProjection = Join-Path $runRoot 'candidate-first-projection.json'
$secondProjection = Join-Path $runRoot 'candidate-second-projection.json'
$baselineManifest = Join-Path $runRoot 'baseline-raw-manifest.json'
$candidateProvenanceVerified = Join-Path $runRoot 'candidate-provenance-verified.json'
$originalAppData = $env:APPDATA
$originalE2eExecutable = $env:BABYDIARY_E2E_EXECUTABLE
$originalSyncE2eExecutable = $env:BABYDIARY_SYNC_E2E_EXECUTABLE
$originalSyncE2eUpgradeProfile = $env:BABYDIARY_SYNC_E2E_UPGRADE_PROFILE
$originalExpectedE2eArch = $env:BABYDIARY_EXPECTED_E2E_ARCH
$originalCanonicalData = if ([string]::IsNullOrWhiteSpace($originalAppData)) {
  $null
} else {
  Join-Path $originalAppData 'baby-diary'
}

$script:failureInjected = $false
$script:baselineManifestCreated = $false
$script:candidateFirstLaunchStarted = $false
$script:candidateFirstLaunchCompleted = $false

function Initialize-BoundedProcessJobApi {
  if ('BabyDiary.Upgrade.JobObjectProcess' -as [type]) { return }
  $source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace BabyDiary.Upgrade
{
    public sealed class JobProcessResult
    {
        public int ExitCode { get; set; }
        public int ProcessId { get; set; }
        public bool TimedOut { get; set; }
        public bool CleanupVerified { get; set; }
    }

    public static class JobObjectProcess
    {
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_NO_WINDOW = 0x08000000;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const int JobObjectBasicAccountingInformation = 1;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint WAIT_OBJECT_0 = 0x00000000;
        private const uint WAIT_TIMEOUT = 0x00000102;
        private const uint INFINITE = 0xFFFFFFFF;
        private const int ROOT_EXIT_BACKOFF_MILLISECONDS = 25;

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public uint cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(
            IntPtr job,
            int informationClass,
            out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
            uint informationLength,
            IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private static Win32Exception LastWin32(string operation)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
        }

        private static string QuoteArgument(string value)
        {
            if (value == null) value = String.Empty;
            if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                return value;
            }

            StringBuilder quoted = new StringBuilder();
            quoted.Append('"');
            int backslashes = 0;
            for (int index = 0; index < value.Length; index += 1)
            {
                char current = value[index];
                if (current == '\\')
                {
                    backslashes += 1;
                    continue;
                }
                if (current == '"')
                {
                    quoted.Append('\\', (backslashes * 2) + 1);
                    quoted.Append('"');
                    backslashes = 0;
                    continue;
                }
                quoted.Append('\\', backslashes);
                quoted.Append(current);
                backslashes = 0;
            }
            quoted.Append('\\', backslashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }

        private static StringBuilder BuildCommandLine(string filePath, string[] arguments)
        {
            StringBuilder commandLine = new StringBuilder(QuoteArgument(filePath));
            if (arguments != null)
            {
                for (int index = 0; index < arguments.Length; index += 1)
                {
                    commandLine.Append(' ');
                    commandLine.Append(QuoteArgument(arguments[index]));
                }
            }
            return commandLine;
        }

        private static void ConfigureKillOnClose(IntPtr job)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)length))
                {
                    throw LastWin32("SetInformationJobObject");
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static uint GetActiveProcessCount(IntPtr job)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
            uint length = (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            if (!QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                out accounting,
                length,
                IntPtr.Zero))
            {
                throw LastWin32("QueryInformationJobObject");
            }
            return accounting.ActiveProcesses;
        }

        private static void WaitForJobEmpty(IntPtr job, int cleanupTimeoutMilliseconds)
        {
            Stopwatch elapsed = Stopwatch.StartNew();
            while (GetActiveProcessCount(job) != 0)
            {
                if (elapsed.ElapsedMilliseconds >= cleanupTimeoutMilliseconds)
                {
                    throw new TimeoutException("Job Object cleanup did not reach zero active processes");
                }
                Thread.Sleep(25);
            }
        }

        private static void TerminateAndVerifyJob(IntPtr job, int cleanupTimeoutMilliseconds)
        {
            if (GetActiveProcessCount(job) == 0) return;
            if (!TerminateJobObject(job, 1))
            {
                throw LastWin32("TerminateJobObject");
            }
            WaitForJobEmpty(job, cleanupTimeoutMilliseconds);
        }

        private static void RecordCleanupFailure(ref Exception failure, Exception cleanupFailure)
        {
            if (failure == null)
            {
                failure = cleanupFailure;
                return;
            }
            failure.Data["JobObjectCleanup"] = cleanupFailure.ToString();
        }

        private static void CloseNativeHandle(IntPtr handle, string label, ref Exception failure)
        {
            if (handle == IntPtr.Zero) return;
            if (!CloseHandle(handle))
            {
                RecordCleanupFailure(ref failure, LastWin32("CloseHandle(" + label + ")"));
            }
        }

        public static JobProcessResult Run(
            string filePath,
            string[] arguments,
            string workingDirectory,
            int timeoutMilliseconds,
            int cleanupTimeoutMilliseconds)
        {
            if (String.IsNullOrWhiteSpace(filePath)) throw new ArgumentException("filePath is required");
            if (timeoutMilliseconds <= 0) throw new ArgumentOutOfRangeException("timeoutMilliseconds");
            if (cleanupTimeoutMilliseconds <= 0) throw new ArgumentOutOfRangeException("cleanupTimeoutMilliseconds");

            IntPtr job = IntPtr.Zero;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            bool processCreated = false;
            bool processAssigned = false;
            JobProcessResult result = null;
            Exception failure = null;

            try
            {
                job = CreateJobObjectW(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw LastWin32("CreateJobObjectW");
                ConfigureKillOnClose(job);

                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
                StringBuilder commandLine = BuildCommandLine(filePath, arguments);
                string currentDirectory = String.IsNullOrWhiteSpace(workingDirectory)
                    ? Environment.CurrentDirectory
                    : workingDirectory;
                if (!CreateProcessW(
                    filePath,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CREATE_SUSPENDED | CREATE_NO_WINDOW,
                    IntPtr.Zero,
                    currentDirectory,
                    ref startup,
                    out process))
                {
                    throw LastWin32("CreateProcessW");
                }
                processCreated = true;

                if (!AssignProcessToJobObject(job, process.hProcess))
                {
                    throw LastWin32("AssignProcessToJobObject");
                }
                processAssigned = true;
                if (ResumeThread(process.hThread) == UInt32.MaxValue)
                {
                    throw LastWin32("ResumeThread");
                }

                Stopwatch elapsed = Stopwatch.StartNew();
                bool timedOut = false;
                while (GetActiveProcessCount(job) != 0)
                {
                    long remaining = timeoutMilliseconds - elapsed.ElapsedMilliseconds;
                    if (remaining <= 0)
                    {
                        timedOut = true;
                        break;
                    }
                    uint wait = (uint)Math.Min(50L, remaining);
                    uint waitResult = WaitForSingleObject(process.hProcess, wait);
                    if (waitResult != WAIT_OBJECT_0 && waitResult != WAIT_TIMEOUT)
                    {
                        throw LastWin32("WaitForSingleObject");
                    }
                    if (waitResult == WAIT_OBJECT_0 && GetActiveProcessCount(job) != 0)
                    {
                        long backoffRemaining = timeoutMilliseconds - elapsed.ElapsedMilliseconds;
                        if (backoffRemaining > 0)
                        {
                            int backoffMilliseconds = (int)Math.Min(
                                (long)ROOT_EXIT_BACKOFF_MILLISECONDS,
                                backoffRemaining);
                            Thread.Sleep(backoffMilliseconds);
                        }
                    }
                }

                if (timedOut)
                {
                    TerminateAndVerifyJob(job, cleanupTimeoutMilliseconds);
                    result = new JobProcessResult
                    {
                        ExitCode = -1,
                        ProcessId = unchecked((int)process.dwProcessId),
                        TimedOut = true,
                        CleanupVerified = true
                    };
                }
                else
                {
                    uint exitCode;
                    if (!GetExitCodeProcess(process.hProcess, out exitCode))
                    {
                        throw LastWin32("GetExitCodeProcess");
                    }
                    result = new JobProcessResult
                    {
                        ExitCode = unchecked((int)exitCode),
                        ProcessId = unchecked((int)process.dwProcessId),
                        TimedOut = false,
                        CleanupVerified = true
                    };
                }
            }
            catch (Exception error)
            {
                failure = error;
            }
            finally
            {
                if (processAssigned && job != IntPtr.Zero)
                {
                    try
                    {
                        TerminateAndVerifyJob(job, cleanupTimeoutMilliseconds);
                    }
                    catch (Exception cleanupError)
                    {
                        RecordCleanupFailure(ref failure, cleanupError);
                    }
                }
                else if (processCreated && process.hProcess != IntPtr.Zero)
                {
                    try
                    {
                        if (WaitForSingleObject(process.hProcess, 0) == WAIT_TIMEOUT)
                        {
                            if (!TerminateProcess(process.hProcess, 1))
                            {
                                throw LastWin32("TerminateProcess");
                            }
                            if (WaitForSingleObject(process.hProcess, (uint)cleanupTimeoutMilliseconds) == WAIT_TIMEOUT)
                            {
                                throw new TimeoutException("Unassigned suspended process cleanup timed out");
                            }
                        }
                    }
                    catch (Exception cleanupError)
                    {
                        RecordCleanupFailure(ref failure, cleanupError);
                    }
                }

                CloseNativeHandle(process.hThread, "thread", ref failure);
                CloseNativeHandle(process.hProcess, "process", ref failure);
                CloseNativeHandle(job, "job", ref failure);
            }

            if (failure != null) throw failure;
            return result;
        }
    }
}
'@
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
}

function Invoke-BoundedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][string]$Label,
    [string]$WorkingDirectory,
    [switch]$AllowNonZero
  )
  if ($TimeoutSeconds -le 0) { throw 'Bounded process timeout must be positive' }
  if ($ProcessCleanupTimeoutSeconds -le 0) { throw 'Job Object cleanup timeout must be positive' }
  Initialize-BoundedProcessJobApi
  $command = Get-Command -Name $FilePath -CommandType Application -ErrorAction Stop
  $resolvedFilePath = [IO.Path]::GetFullPath($command.Source)
  if ([IO.Path]::GetExtension($resolvedFilePath) -in @('.cmd', '.bat')) {
    throw 'Invoke-BoundedProcess requires a native executable root process'
  }
  $result = [BabyDiary.Upgrade.JobObjectProcess]::Run(
    $resolvedFilePath,
    [string[]]@($Arguments),
    $WorkingDirectory,
    $TimeoutSeconds * 1000,
    $ProcessCleanupTimeoutSeconds * 1000
  )
  if (-not $result.CleanupVerified) {
    throw "$Label Job Object cleanup was not verified"
  }
  if ($result.TimedOut) {
    $exception = [TimeoutException]::new("$Label exceeded its bounded timeout")
    $exception.Data['FailureKind'] = 'timeout'
    throw $exception
  }
  if (-not $AllowNonZero -and $result.ExitCode -ne 0) {
    throw "$Label failed with exit code $($result.ExitCode)"
  }
  return [pscustomobject]@{ ExitCode = $result.ExitCode; ProcessId = $result.ProcessId }
}

function Resolve-RegularFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $item = Get-Item -LiteralPath $resolved -Force
  if (-not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    return $resolved
  }
  throw "Expected a regular file without a reparse point: $Path"
}

function Assert-CandidateProvenance {
  $arguments = @(
    $dataContract,
    'verify-provenance',
    '--package', $CandidateSetupPath,
    '--provenance', $CandidateProvenancePath,
    '--output', $candidateProvenanceVerified,
    '--expected-repository', $ExpectedRepository,
    '--expected-workflow-run-id', $ExpectedWorkflowRunId,
    '--expected-source-sha', $CandidateSourceSha,
    '--expected-release-tag', 'v0.3.9',
    '--expected-app-version', $ExpectedCandidateVersion,
    '--expected-platform', 'windows-x64',
    '--expected-artifact-name', ([IO.Path]::GetFileName($CandidateSetupPath)),
    '--expected-artifact-sha256', $CandidatePackageSha256
  )
  Invoke-Node -Arguments $arguments
  $verified = Get-Content -LiteralPath $candidateProvenanceVerified -Raw | ConvertFrom-Json
  Write-Output (
    'Verified candidate provenance binding: repository={0} run={1} source={2} artifact={3} sha256={4}' -f
      $verified.repository,
      $verified.workflowRunId,
      $verified.sourceSha,
      $verified.artifactName,
      $verified.artifactSha256
  )
}

function Get-BabyDiaryInstall {
  $registryPaths = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$ExpectedRegistryChildName",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$ExpectedRegistryChildName",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$ExpectedRegistryChildName"
  )
  $entries = foreach ($registryPath in $registryPaths) {
    Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue
  }
  return @($entries)
}

function Get-BabyDiaryNamedUninstallEntries {
  $registryRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entries = foreach ($root in $registryRoots) {
    Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | Where-Object {
      -not [string]::IsNullOrWhiteSpace([string]$_.DisplayName) -and
      ([string]$_.DisplayName).StartsWith($ExpectedProductName, [StringComparison]::Ordinal)
    }
  }
  return @($entries)
}

function Get-UninstallerPath {
  param([Parameter(Mandatory = $true)][string]$UninstallString)
  if ($UninstallString -match '^"([^"]+\.exe)"') { return $Matches[1] }
  if ($UninstallString -match '^(.+?\.exe)(?:\s|$)') { return $Matches[1] }
  throw 'Could not parse the exact Baby Diary UninstallString'
}

function Get-RequiredRegistryString {
  param(
    [Parameter(Mandatory = $true)][object]$Entry,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $property = $Entry.PSObject.Properties[$Name]
  if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
    throw "Baby Diary uninstall registry field is missing: $Name"
  }
  return [string]$property.Value
}

function Get-OptionalRegistryStringState {
  param(
    [Parameter(Mandatory = $true)][object]$Entry,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $property = $Entry.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return [pscustomobject]@{ Present = $false; Value = $null }
  }
  $value = [string]$property.Value
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Baby Diary uninstall registry field is empty: $Name"
  }
  return [pscustomobject]@{ Present = $true; Value = $value }
}

function Get-RegistryHiveFromPsPath {
  param([Parameter(Mandatory = $true)][string]$PSPath)
  $prefix = 'Microsoft.PowerShell.Core\Registry::'
  if (-not $PSPath.StartsWith($prefix, [StringComparison]::Ordinal)) {
    throw 'Baby Diary registry PSPath has an unexpected provider identity'
  }
  $providerPath = $PSPath.Substring($prefix.Length)
  $separator = $providerPath.IndexOf('\')
  if ($separator -le 0) { throw 'Baby Diary registry PSPath has no exact hive identity' }
  $hive = $providerPath.Substring(0, $separator)
  if ($hive -notin @('HKEY_CURRENT_USER', 'HKEY_LOCAL_MACHINE')) {
    throw "Baby Diary registry hive is not allowed: $hive"
  }
  return $hive
}

function Get-ExactInstalledApplication {
  param(
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][ValidateSet('Baseline', 'Candidate')][string]$Stage
  )
  $entries = @(Get-BabyDiaryInstall)
  if ($entries.Count -ne 1) {
    throw "Expected exactly one Baby Diary uninstall entry, found $($entries.Count)"
  }
  $entry = $entries[0]
  $namedEntries = @(Get-BabyDiaryNamedUninstallEntries)
  if ($namedEntries.Count -ne 1) {
    throw "Expected exactly one Baby Diary named uninstall entry without a legacy duplicate, found $($namedEntries.Count)"
  }
  $psPath = Get-RequiredRegistryString -Entry $entry -Name 'PSPath'
  $psChildName = Get-RequiredRegistryString -Entry $entry -Name 'PSChildName'
  $displayName = Get-RequiredRegistryString -Entry $entry -Name 'DisplayName'
  $displayVersion = Get-RequiredRegistryString -Entry $entry -Name 'DisplayVersion'
  $publisherState = Get-OptionalRegistryStringState -Entry $entry -Name 'Publisher'
  $uninstallString = Get-RequiredRegistryString -Entry $entry -Name 'UninstallString'
  $quietUninstallString = Get-RequiredRegistryString -Entry $entry -Name 'QuietUninstallString'
  $registryHive = Get-RegistryHiveFromPsPath -PSPath $psPath
  if (-not [string]::Equals(
      (Get-RequiredRegistryString -Entry $namedEntries[0] -Name 'PSPath'),
      $psPath,
      [StringComparison]::Ordinal
    )) {
    throw 'Baby Diary named uninstall entry is not the pinned appId registry identity'
  }
  $expectedDisplayName = if ($Stage -eq 'Baseline') { $ExpectedBaselineDisplayName } else { $ExpectedCandidateDisplayName }
  $expectedShortcutName = if ($Stage -eq 'Baseline') { $ExpectedBaselineShortcutName } else { $ExpectedCandidateShortcutName }
  if (-not [string]::Equals($displayName, $expectedDisplayName, [StringComparison]::Ordinal)) {
    throw "Baby Diary $Stage registry DisplayName does not match the exact package metadata"
  }
  if (-not [string]::Equals($displayVersion, $ExpectedVersion, [StringComparison]::Ordinal)) {
    throw "Baby Diary registry DisplayVersion does not equal $ExpectedVersion"
  }
  if ($Stage -eq 'Baseline' -and $publisherState.Present) {
    throw 'Baby Diary baseline registry Publisher must be absent exactly as in v0.3.8 metadata'
  }
  if ($Stage -eq 'Candidate' -and (
      -not $publisherState.Present -or
      -not [string]::Equals($publisherState.Value, $ExpectedCandidateRegistryPublisher, [StringComparison]::Ordinal)
    )) {
    throw 'Baby Diary candidate registry Publisher does not match the exact v0.3.9 metadata'
  }
  if (-not [string]::Equals($psChildName, $ExpectedRegistryChildName, [StringComparison]::Ordinal)) {
    throw 'Baby Diary registry PSChildName does not match the pinned application identity'
  }
  if (-not [string]::Equals($registryHive, 'HKEY_CURRENT_USER', [StringComparison]::Ordinal)) {
    throw 'Baby Diary registry hive is not the expected per-user installation hive'
  }

  # electron-builder stores InstallLocation under Software\APP_GUID and the
  # uninstall commands under CurrentVersion\Uninstall\APP_GUID. Bind both
  # exact records instead of inferring the install registry record by name.
  $installRegistryPath = "HKCU:\Software\$ExpectedRegistryChildName"
  $installEntry = Get-ItemProperty -LiteralPath $installRegistryPath -ErrorAction Stop
  $installRegistryPsPath = Get-RequiredRegistryString -Entry $installEntry -Name 'PSPath'
  $installRegistryPsChildName = Get-RequiredRegistryString -Entry $installEntry -Name 'PSChildName'
  $registryInstallLocation = Get-RequiredRegistryString -Entry $installEntry -Name 'InstallLocation'
  $keepShortcuts = Get-RequiredRegistryString -Entry $installEntry -Name 'KeepShortcuts'
  $shortcutName = Get-RequiredRegistryString -Entry $installEntry -Name 'ShortcutName'
  if (-not [string]::Equals($installRegistryPsChildName, $ExpectedRegistryChildName, [StringComparison]::Ordinal)) {
    throw 'Baby Diary install registry PSChildName does not match the uninstall identity'
  }
  if (-not [string]::Equals(
      (Get-RegistryHiveFromPsPath -PSPath $installRegistryPsPath),
      $registryHive,
      [StringComparison]::Ordinal
    )) {
    throw 'Baby Diary install and uninstall registry hives differ'
  }
  if (-not [string]::Equals($keepShortcuts, 'true', [StringComparison]::Ordinal) -or
      -not [string]::Equals($shortcutName, $expectedShortcutName, [StringComparison]::Ordinal)) {
    throw "Baby Diary $Stage install registry shortcut identity does not match the exact package metadata"
  }

  $installLocationPath = [IO.Path]::GetFullPath($registryInstallLocation.Trim().Trim('"'))
  $registeredUninstallerPath = Get-UninstallerPath -UninstallString $uninstallString
  $expectedUninstallString = '"' + $registeredUninstallerPath + '" ' + $ExpectedInstallChannelArgument
  $expectedQuietUninstallString = "$expectedUninstallString /S"
  if (-not [string]::Equals($uninstallString, $expectedUninstallString, [StringComparison]::Ordinal) -or
      -not [string]::Equals($quietUninstallString, $expectedQuietUninstallString, [StringComparison]::Ordinal)) {
    throw "Baby Diary $Stage uninstall commands do not match the exact per-user install channel"
  }
  $uninstallerPath = $registeredUninstallerPath
  $uninstallerPath = [IO.Path]::GetFullPath($uninstallerPath)
  if (-not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
    throw "Baby Diary uninstaller not found: $uninstallerPath"
  }
  $uninstallerParent = [IO.Path]::GetFullPath((Split-Path -Parent $uninstallerPath))
  if (-not [string]::Equals(
      $uninstallerParent,
      $installLocationPath,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'Baby Diary registry InstallLocation does not own the registered uninstaller'
  }
  $quietUninstallerPath = [IO.Path]::GetFullPath(
    (Get-UninstallerPath -UninstallString $quietUninstallString)
  )
  if (-not [string]::Equals(
      $quietUninstallerPath,
      $uninstallerPath,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'Baby Diary registry QuietUninstallString targets a different uninstaller'
  }
  $executable = Join-Path $installLocationPath "$ExpectedProductName.exe"
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Installed Baby Diary executable not found: $executable"
  }
  return [pscustomobject]@{
    PSPath = $psPath
    PSChildName = $psChildName
    RegistryHive = $registryHive
    DisplayName = $displayName
    DisplayVersion = $displayVersion
    PublisherPresent = $publisherState.Present
    Publisher = $publisherState.Value
    InstallRegistryPSPath = $installRegistryPsPath
    InstallRegistryPSChildName = $installRegistryPsChildName
    InstallLocation = $registryInstallLocation
    KeepShortcuts = $keepShortcuts
    ShortcutName = $shortcutName
    UninstallString = $uninstallString
    QuietUninstallString = $quietUninstallString
    UninstallerPath = $uninstallerPath
    InstallLocationPath = $installLocationPath
    Executable = [IO.Path]::GetFullPath($executable)
  }
}

function Write-InstallRegistryEvidence {
  param(
    [Parameter(Mandatory = $true)][object]$Install,
    [Parameter(Mandatory = $true)][ValidateSet('Baseline', 'Candidate')][string]$Stage,
    [Parameter(Mandatory = $true)][string]$Path
  )
  [ordered]@{
    schemaVersion = 1
    stage = $Stage
    appId = $ExpectedAppId
    productName = $ExpectedProductName
    installChannel = $ExpectedInstallChannelArgument
    contractSource = if ($Stage -eq 'Baseline') {
      'published-v0.3.8-installer-and-tag-source'
    } else {
      'candidate-package-config-provenance-and-signed-installer'
    }
    sourceSha = if ($Stage -eq 'Baseline') { $BaselineSourceSha } else { $CandidateSourceSha }
    packageSha256 = if ($Stage -eq 'Baseline') { $BaselineAssetSha256 } else { $CandidatePackageSha256 }
    PSPath = $Install.PSPath
    PSChildName = $Install.PSChildName
    RegistryHive = $Install.RegistryHive
    DisplayName = $Install.DisplayName
    DisplayVersion = $Install.DisplayVersion
    PublisherPresent = $Install.PublisherPresent
    Publisher = $Install.Publisher
    InstallRegistryPSPath = $Install.InstallRegistryPSPath
    InstallRegistryPSChildName = $Install.InstallRegistryPSChildName
    InstallLocation = $Install.InstallLocation
    ShortcutName = $Install.ShortcutName
    UninstallString = $Install.UninstallString
    QuietUninstallString = $Install.QuietUninstallString
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Assert-UpgradeRegistryIdentity {
  param(
    [Parameter(Mandatory = $true)][object]$Baseline,
    [Parameter(Mandatory = $true)][object]$Candidate
  )
  $exactFields = @(
    'PSPath',
    'PSChildName',
    'RegistryHive',
    'InstallRegistryPSPath',
    'InstallRegistryPSChildName',
    'InstallLocation',
    'KeepShortcuts',
    'UninstallString',
    'QuietUninstallString'
  )
  $fieldErrors = @{
    PSPath = 'Baby Diary registry PSPath changed across in-place replacement'
    PSChildName = 'Baby Diary registry PSChildName changed across in-place replacement'
    RegistryHive = 'Baby Diary registry hive changed across in-place replacement'
    InstallRegistryPSPath = 'Baby Diary install registry PSPath changed across in-place replacement'
    InstallRegistryPSChildName = 'Baby Diary install registry PSChildName changed across in-place replacement'
    InstallLocation = 'Baby Diary registry InstallLocation changed across in-place replacement'
    KeepShortcuts = 'Baby Diary install registry KeepShortcuts changed across in-place replacement'
    UninstallString = 'Baby Diary registry UninstallString changed across in-place replacement'
    QuietUninstallString = 'Baby Diary registry QuietUninstallString changed across in-place replacement'
  }
  foreach ($field in $exactFields) {
    if (-not [string]::Equals(
        [string]$Baseline.$field,
        [string]$Candidate.$field,
        [StringComparison]::Ordinal
      )) {
      throw $fieldErrors[$field]
    }
  }
  foreach ($field in @('UninstallerPath', 'InstallLocationPath', 'Executable')) {
    if (-not [string]::Equals(
        [IO.Path]::GetFullPath([string]$Baseline.$field),
        [IO.Path]::GetFullPath([string]$Candidate.$field),
        [StringComparison]::OrdinalIgnoreCase
      )) {
      throw "Baby Diary installed application $field changed across in-place replacement"
    }
  }
  if (-not [string]::Equals($Baseline.DisplayName, $ExpectedBaselineDisplayName, [StringComparison]::Ordinal) -or
      -not [string]::Equals($Candidate.DisplayName, $ExpectedCandidateDisplayName, [StringComparison]::Ordinal)) {
    throw 'Baby Diary registry DisplayName transition is not the exact baseline-to-candidate mapping'
  }
  if ($Baseline.PublisherPresent -or -not $Candidate.PublisherPresent -or
      -not [string]::Equals($Candidate.Publisher, $ExpectedCandidateRegistryPublisher, [StringComparison]::Ordinal)) {
    throw 'Baby Diary registry Publisher transition is not the exact baseline-to-candidate mapping'
  }
  if (-not [string]::Equals($Baseline.ShortcutName, $ExpectedBaselineShortcutName, [StringComparison]::Ordinal) -or
      -not [string]::Equals($Candidate.ShortcutName, $ExpectedCandidateShortcutName, [StringComparison]::Ordinal)) {
    throw 'Baby Diary install registry ShortcutName transition is not the exact baseline-to-candidate mapping'
  }
}

function Assert-BaselineAssetContract {
  param([Parameter(Mandatory = $true)][string]$Path)
  $item = Get-Item -LiteralPath $Path
  if (-not [string]::Equals($item.Name, $BaselineAssetName, [StringComparison]::Ordinal)) {
    throw 'Historical baseline asset name does not match the pinned release asset'
  }
  if ($item.Length -ne $BaselineAssetSize) {
    throw "Historical baseline asset size mismatch: $($item.Length)"
  }
  $digest = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  if (-not [string]::Equals($digest, $BaselineAssetSha256, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Historical baseline asset SHA-256 mismatch'
  }
}

function Record-BaselineLegacyTrust {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$OutputPath
  )
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $record = [ordered]@{
    releaseId = $BaselineReleaseId
    assetId = $BaselineAssetId
    assetName = $BaselineAssetName
    sourceSha = $BaselineSourceSha
    sha256 = $BaselineAssetSha256
    trustPolicy = 'legacy-input-evidence-only'
    authenticodeStatus = $signature.Status.ToString()
    signerSubject = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Subject }
    signerThumbprint = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Thumbprint }
    timestampPresent = ($null -ne $signature.TimeStamperCertificate)
  }
  $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
}

function Assert-CandidateSignature {
  param([Parameter(Mandatory = $true)][string]$Path)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status.ToString() -ne 'Valid') {
    throw "Candidate Authenticode status is not Valid: $Path"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Candidate trusted timestamp is missing: $Path"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "Candidate signer certificate is missing: $Path"
  }
  if (-not [string]::Equals(
      $signature.SignerCertificate.Subject,
      $ExpectedPublisher,
      [System.StringComparison]::Ordinal
    )) {
    throw "Candidate publisher Subject mismatch: $Path"
  }
  $certificateSha256 = $signature.SignerCertificate.GetCertHashString(
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
  )
  if (-not [string]::Equals(
      $certificateSha256,
      $ExpectedCertificateSha256,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Candidate signer certificate SHA-256 mismatch: $Path"
  }
}

function Assert-X64Pe {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $reader = New-Object IO.BinaryReader($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw "PE DOS header is invalid: $Path" }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) { throw "PE offset is invalid: $Path" }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "PE signature is invalid: $Path" }
    if ($reader.ReadUInt16() -ne 0x8664) { throw "Installed Baby Diary executable is not x64: $Path" }
  }
  finally {
    $stream.Dispose()
  }
}

function Start-VerifiedSetup {
  param(
    [Parameter(Mandatory = $true)][string]$SetupPath,
    [Parameter(Mandatory = $true)][ValidateSet('Baseline', 'Candidate')][string]$Label
  )
  $result = Invoke-BoundedProcess -FilePath $SetupPath -Arguments @('/S') `
    -TimeoutSeconds $SetupTimeoutSeconds -Label "$Label Setup" -AllowNonZero
  if ($result.ExitCode -ne 0) {
    if ($Label -eq 'Candidate') {
      throw "Candidate Setup failed with exit code $($result.ExitCode)"
    }
    throw "Baseline Setup failed with exit code $($result.ExitCode)"
  }
}

function Invoke-Node {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $json = ConvertTo-Json -Compress -InputObject @($Arguments)
  $encodedArguments = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $childCommand = @"
`$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$encodedArguments'))
`$arguments = @(`$json | ConvertFrom-Json)
& node @arguments
exit `$LASTEXITCODE
"@
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))
  $result = Invoke-BoundedProcess -FilePath 'powershell.exe' `
    -Arguments @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedCommand) `
    -TimeoutSeconds $DriverTimeoutSeconds -Label 'Node upgrade driver' -AllowNonZero
  if ($result.ExitCode -ne 0) {
    throw "Node command failed with exit code $($result.ExitCode)"
  }
}

function Invoke-UpgradePhase {
  param(
    [Parameter(Mandatory = $true)][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][string]$SourceSha,
    [Parameter(Mandatory = $true)][string]$DiagnosticPath,
    [Parameter(Mandatory = $true)][string]$ProjectionOutput,
    [string]$ComparisonProjection
  )
  $arguments = @(
    $upgradeDriver,
    '--mode', $Mode,
    '--executable', $Executable,
    '--profile-root', $canonicalProfile,
    '--temp-root', $runRoot,
    '--run-id', $runId,
    '--diagnostic', $DiagnosticPath,
    '--projection-output', $ProjectionOutput,
    '--source-sha', $SourceSha,
    '--expected-version', $ExpectedVersion,
    '--expected-arch', 'x64'
  )
  if (-not [string]::IsNullOrWhiteSpace($ComparisonProjection)) {
    $arguments += @('--comparison-projection', $ComparisonProjection)
  }
  if (-not [string]::IsNullOrWhiteSpace($originalCanonicalData)) {
    $arguments += @('--forbidden-root', $originalCanonicalData)
  }
  $allowMissingProfile = $Mode -eq 'baseline-initialize'
  Assert-CanonicalProfileTreeWithoutReparsePoints -AllowMissing:$allowMissingProfile
  $phaseCompleted = $false
  try {
    Invoke-Node -Arguments $arguments
    $phaseCompleted = $true
  }
  finally {
    $allowMissingAfterFailure = $allowMissingProfile -and -not $phaseCompleted
    Assert-CanonicalProfileTreeWithoutReparsePoints -AllowMissing:$allowMissingAfterFailure
  }
}

function New-BaselineManifest {
  Invoke-Node -Arguments @(
    $dataContract,
    'manifest',
    '--root', $canonicalProfile,
    '--output', $baselineManifest
  )
  $script:baselineManifestCreated = $true
}

function Assert-ProfileMatchesBaseline {
  if (-not (Test-Path -LiteralPath $baselineManifest -PathType Leaf)) {
    throw 'Baseline raw manifest is unavailable for preservation proof'
  }
  Invoke-Node -Arguments @(
    $dataContract,
    'compare-manifest',
    '--root', $canonicalProfile,
    '--before', $baselineManifest
  )
}

function Invoke-FailurePoint {
  param([Parameter(Mandatory = $true)][string]$Point)
  if ([string]::Equals($FailurePoint, $Point, [StringComparison]::Ordinal)) {
    $script:failureInjected = $true
    throw "Injected deterministic wrapper failure at $Point"
  }
}

function Assert-FailureInvariant {
  if ($script:baselineManifestCreated -and -not $script:candidateFirstLaunchStarted) {
    Assert-ProfileMatchesBaseline
  }
}

function Install-CandidateWithRetry {
  for ($attempt = 0; $attempt -lt 2; $attempt += 1) {
    try {
      Invoke-FailurePoint -Point 'during-candidate-replacement'
      Start-VerifiedSetup -SetupPath $CandidateSetupPath -Label 'Candidate'
      return
    }
    catch {
      Assert-ProfileMatchesBaseline
      if ($script:failureInjected -or $attempt -eq 1) { throw }
      Write-Warning 'Retrying after an ordinary candidate replacement failure with the raw profile unchanged'
    }
  }
  throw 'Candidate replacement retry bound was exhausted'
}

function Assert-ExactShortcut {
  param([Parameter(Mandatory = $true)][string]$CandidateExecutable)
  $shell = New-Object -ComObject WScript.Shell
  try {
    $desktopFolders = @(
      $shell.SpecialFolders.Item('Desktop'),
      $shell.SpecialFolders.Item('AllUsersDesktop')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    $resolved = foreach ($folder in $desktopFolders) {
      if (-not (Test-Path -LiteralPath $folder -PathType Container)) { continue }
      foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -ErrorAction SilentlyContinue) {
        $shortcut = $shell.CreateShortcut($file.FullName)
        [pscustomobject]@{
          Path = $file.FullName
          Name = $file.Name
          TargetPath = [string]$shortcut.TargetPath
          Arguments = [string]$shortcut.Arguments
          WorkingDirectory = [string]$shortcut.WorkingDirectory
        }
      }
    }
    $applicable = @($resolved | Where-Object {
      $nameMatches = [string]::Equals($_.Name, 'Baby Diary.lnk', [StringComparison]::OrdinalIgnoreCase)
      $targetMatches = -not [string]::IsNullOrWhiteSpace($_.TargetPath) -and
        [string]::Equals(
          [IO.Path]::GetFullPath($_.TargetPath),
          $CandidateExecutable,
          [StringComparison]::OrdinalIgnoreCase
        )
      $nameMatches -or $targetMatches
    })
    $legacyShortcutName = "$ExpectedBaselineShortcutName.lnk"
    $legacyShortcuts = @($resolved | Where-Object {
      [string]::Equals($_.Name, $legacyShortcutName, [StringComparison]::Ordinal)
    })
    if ($legacyShortcuts.Count -ne 0) {
      throw "Expected zero legacy baseline shortcuts after upgrade, found $($legacyShortcuts.Count)"
    }
    if ($applicable.Count -ne 1) {
      throw "Expected exactly one applicable Baby Diary shortcut, found $($applicable.Count)"
    }
    $candidate = $applicable[0]
    if (-not [string]::Equals($candidate.Name, 'Baby Diary.lnk', [StringComparison]::Ordinal)) {
      throw "Applicable shortcut name is not exactly Baby Diary.lnk: $($candidate.Name)"
    }
    if (-not [string]::Equals(
        [IO.Path]::GetFullPath($candidate.TargetPath),
        $CandidateExecutable,
        [StringComparison]::OrdinalIgnoreCase
      )) {
      throw 'Baby Diary shortcut TargetPath does not match the exact candidate executable'
    }
    if (-not [string]::Equals($candidate.Arguments, '', [StringComparison]::Ordinal)) {
      throw 'Baby Diary shortcut Arguments must be empty'
    }
    $installDirectory = Split-Path -Parent $CandidateExecutable
    if (-not [string]::Equals(
        [IO.Path]::GetFullPath($candidate.WorkingDirectory),
        $installDirectory,
        [StringComparison]::OrdinalIgnoreCase
      )) {
      throw 'Baby Diary shortcut WorkingDirectory does not match the candidate install directory'
    }
  }
  finally {
    if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  }
}

function Invoke-NpmScript {
  param([Parameter(Mandatory = $true)][string]$Name)
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  $json = ConvertTo-Json -Compress -InputObject @('run', $Name)
  $encodedArguments = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $npmLiteral = $npm.Replace("'", "''")
  $childCommand = @"
`$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$encodedArguments'))
`$arguments = @(`$json | ConvertFrom-Json)
& '$npmLiteral' @arguments
exit `$LASTEXITCODE
"@
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCommand))
  $result = Invoke-BoundedProcess -FilePath 'powershell.exe' `
    -Arguments @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedCommand) `
    -TimeoutSeconds $NpmTimeoutSeconds -Label "npm run $Name" -WorkingDirectory $repoRoot -AllowNonZero
  if ($result.ExitCode -ne 0) { throw "npm run $Name failed with exit code $($result.ExitCode)" }
}

function Invoke-VerifiedUninstall {
  param([string]$KnownInstallLocation)
  $entries = @(Get-BabyDiaryInstall)
  if ($entries.Count -gt 1) {
    throw "Installation cleanup found multiple Baby Diary uninstall entries: $($entries.Count)"
  }
  if ($entries.Count -eq 1) {
    $uninstaller = Get-UninstallerPath -UninstallString $entries[0].UninstallString
    $uninstaller = [IO.Path]::GetFullPath($uninstaller)
    if (-not [string]::IsNullOrWhiteSpace($KnownInstallLocation)) {
      $actualLocation = Split-Path -Parent $uninstaller
      if (-not [string]::Equals(
          [IO.Path]::GetFullPath($actualLocation),
          [IO.Path]::GetFullPath($KnownInstallLocation),
          [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'Installation cleanup refused an unexpected uninstall location'
      }
    }
    $uninstallResult = $null
    for ($attempt = 0; $attempt -lt 2; $attempt += 1) {
      try {
        $uninstallResult = Invoke-BoundedProcess -FilePath $uninstaller -Arguments @('/S') `
          -TimeoutSeconds $UninstallTimeoutSeconds -Label 'Silent uninstall' -AllowNonZero
        if ($uninstallResult.ExitCode -eq 0) { break }
      }
      catch {
        if ($attempt -eq 1) { throw }
      }
    }
    if ($null -eq $uninstallResult -or $uninstallResult.ExitCode -ne 0) {
      throw "Silent uninstall failed with exit code $($uninstallResult.ExitCode)"
    }
  }
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    $remaining = @(Get-BabyDiaryInstall)
    $locationExists = -not [string]::IsNullOrWhiteSpace($KnownInstallLocation) -and
      (Test-Path -LiteralPath $KnownInstallLocation)
    if ($remaining.Count -eq 0 -and -not $locationExists) { return }
    Start-Sleep -Milliseconds 500
  }
  throw 'Baby Diary installation cleanup did not remove the exact registry identity and install directory'
}

function Test-RunOwnedMutationPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$AllowRunRoot
  )
  try {
    $rootFull = [IO.Path]::GetFullPath($runRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $targetFull = [IO.Path]::GetFullPath($Path)
    $comparison = [StringComparison]::OrdinalIgnoreCase
    $isRoot = [string]::Equals($rootFull, $targetFull, $comparison)
    if ($isRoot -and -not $AllowRunRoot) { return $false }
    if (-not $isRoot -and -not $targetFull.StartsWith("$rootFull$([IO.Path]::DirectorySeparatorChar)", $comparison)) {
      return $false
    }

    $rootItem = Get-Item -LiteralPath $rootFull -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      return $false
    }
    if (-not [string]::Equals([IO.Path]::GetFullPath($rootItem.FullName), $rootFull, $comparison)) {
      return $false
    }
    if ($isRoot) { return $true }

    $relative = $targetFull.Substring($rootFull.Length + 1)
    $current = $rootFull
    foreach ($component in $relative.Split([IO.Path]::DirectorySeparatorChar)) {
      if ([string]::IsNullOrWhiteSpace($component) -or $component -eq '.' -or $component -eq '..') {
        return $false
      }
      $current = Join-Path $current $component
      $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
      if ($null -eq $item) { break }
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
      $resolved = (Resolve-Path -LiteralPath $current -ErrorAction Stop).ProviderPath
      if (-not [string]::Equals([IO.Path]::GetFullPath($resolved), [IO.Path]::GetFullPath($current), $comparison)) {
        return $false
      }
    }
    return $true
  }
  catch {
    return $false
  }
}

function Test-RunOwnedTreeWithoutReparsePoints {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-RunOwnedMutationPath -Path $Path -AllowRunRoot)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $true }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
  if (-not $item.PSIsContainer) { return $true }
  try {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push([IO.Path]::GetFullPath($Path))
    while ($pending.Count -gt 0) {
      $current = $pending.Pop()
      foreach ($child in @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)) {
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
        if ($child.PSIsContainer) { $pending.Push($child.FullName) }
      }
    }
    return $true
  }
  catch {
    return $false
  }
}

function Assert-CanonicalProfileTreeWithoutReparsePoints {
  param([switch]$AllowMissing)
  if (-not (Test-Path -LiteralPath $canonicalProfile)) {
    if ($AllowMissing) { return }
    throw 'Canonical upgrade profile is unavailable for native reparse-point verification'
  }
  if (-not (Test-RunOwnedTreeWithoutReparsePoints -Path $canonicalProfile)) {
    throw 'Canonical upgrade profile contains a reparse point or escaped the isolated run root'
  }
}

function Remove-RunOwnedItem {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$Recurse
  )
  if (-not (Test-RunOwnedMutationPath -Path $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { return }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
  if ($Recurse -and -not (Test-RunOwnedTreeWithoutReparsePoints -Path $Path)) { return }
  if (-not (Test-RunOwnedMutationPath -Path $Path)) { return }
  Remove-Item -LiteralPath $Path -Force -Recurse:$Recurse
}

function Scrub-DiagnosticSecrets {
  if (-not (Test-Path -LiteralPath $runRoot -PathType Container)) { return }
  if (-not (Test-RunOwnedMutationPath -Path $canonicalProfile)) { return }
  $settingsPath = Join-Path $canonicalProfile 'settings.json'
  $sensitivePaths = @(
    'Local Storage',
    'Session Storage',
    'IndexedDB',
    'Network',
    'WebStorage',
    'Cookies'
  ) | ForEach-Object { Join-Path $canonicalProfile $_ }
  $markerPath = Join-Path $runRoot 'secrets-scrubbed.json'
  foreach ($candidate in @($settingsPath) + $sensitivePaths + @($markerPath)) {
    if (-not (Test-RunOwnedMutationPath -Path $candidate)) { return }
  }

  $settingsItem = Get-Item -LiteralPath $settingsPath -Force -ErrorAction SilentlyContinue
  if ($null -ne $settingsItem) {
    if ($settingsItem.PSIsContainer -or ($settingsItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
    try {
      $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
      if ($null -ne $settings.PSObject.Properties['firebase']) { $settings.firebase = $null }
      if (-not (Test-RunOwnedMutationPath -Path $settingsPath)) { return }
      $settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    }
    catch {
      Remove-RunOwnedItem -Path $settingsPath
    }
  }
  foreach ($sensitivePath in $sensitivePaths) {
    Remove-RunOwnedItem -Path $sensitivePath -Recurse
  }
  if (-not (Test-RunOwnedMutationPath -Path $markerPath)) { return }
  [ordered]@{
    version = 1
    scrubbed = $true
    removedAuthStores = $true
    firebaseConfigRedacted = $true
  } | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding UTF8
}

function Remove-RunOwnedTempRoot {
  if (-not (Test-Path -LiteralPath $runRoot)) { return }
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedRunRoot = [IO.Path]::GetFullPath($runRoot)
  if (-not $resolvedRunRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals(
        [IO.Path]::GetFileName($resolvedRunRoot),
        "baby-diary-upgrade-$runId",
        [StringComparison]::Ordinal
      )) {
    throw 'Refusing to remove a path that is not the run-owned temp root'
  }
  if (-not (Test-RunOwnedTreeWithoutReparsePoints -Path $resolvedRunRoot)) {
    throw 'Refusing to remove a run root with uncertain or reparse-point components'
  }
  Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force
}

if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) { throw 'ExpectedPublisher is required' }
if ($ExpectedCertificateSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
  throw 'ExpectedCertificateSha256 must be exactly 64 hexadecimal characters'
}
if ($CandidateSourceSha -notmatch '^[0-9a-f]{40}$') {
  throw 'CandidateSourceSha must be exactly 40 lowercase hexadecimal characters'
}
if ($CandidatePackageSha256 -notmatch '^[0-9a-f]{64}$') {
  throw 'CandidatePackageSha256 must be exactly 64 lowercase hexadecimal characters'
}
if ($ExpectedRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  throw 'ExpectedRepository must be an exact owner/repository identity'
}
if ($ExpectedWorkflowRunId -notmatch '^[1-9][0-9]*$') {
  throw 'ExpectedWorkflowRunId must be a positive decimal run identity'
}
if (-not [string]::Equals($ExpectedBaselineVersion, '0.3.8', [StringComparison]::Ordinal)) {
  throw 'This gate accepts only the pinned v0.3.8 baseline version'
}
if (-not [string]::Equals($ExpectedCandidateVersion, '0.3.9', [StringComparison]::Ordinal)) {
  throw 'This gate accepts only the v0.3.9 candidate version'
}
if ([string]::IsNullOrWhiteSpace($originalAppData)) { throw 'The runner APPDATA path is unavailable' }

$BaselineSetupPath = Resolve-RegularFile -Path $BaselineSetupPath
$CandidateSetupPath = Resolve-RegularFile -Path $CandidateSetupPath
$CandidateProvenancePath = Resolve-RegularFile -Path $CandidateProvenancePath
$expectedCandidateName = "Baby-Diary-Setup-$ExpectedCandidateVersion.exe"
if (-not [string]::Equals(
    [IO.Path]::GetFileName($CandidateSetupPath),
    $expectedCandidateName,
    [StringComparison]::Ordinal
  )) {
  throw "Candidate Setup filename must be exactly $expectedCandidateName"
}

$success = $false
$installationStarted = $false
$installLocation = $null
$baselineInstallLocation = $null
$cleanupError = $null

New-Item -ItemType Directory -Path $isolatedAppData -Force | Out-Null

try {
  if (@(Get-BabyDiaryInstall).Count -ne 0) {
    throw 'Refusing to run with a pre-existing Baby Diary installation'
  }
  if (Test-Path -LiteralPath $originalCanonicalData) {
    throw 'Refusing to run with a pre-existing canonical data directory'
  }
  if (Test-Path -LiteralPath $canonicalProfile) {
    throw 'Refusing to reuse the isolated canonical data directory'
  }

  Assert-BaselineAssetContract -Path $BaselineSetupPath
  Record-BaselineLegacyTrust -Path $BaselineSetupPath -OutputPath (Join-Path $runRoot 'baseline-legacy-trust.json')
  Assert-CandidateProvenance
  # Candidate trust is mandatory and is checked before any candidate bytes can replace v0.3.8.
  Assert-CandidateSignature -Path $CandidateSetupPath

  $env:APPDATA = $isolatedAppData
  $installationStarted = $true
  Start-VerifiedSetup -SetupPath $BaselineSetupPath -Label 'Baseline'
  $baselineInstall = Get-ExactInstalledApplication -ExpectedVersion $ExpectedBaselineVersion -Stage 'Baseline'
  Write-InstallRegistryEvidence -Install $baselineInstall -Stage 'Baseline' `
    -Path (Join-Path $runRoot 'baseline-registry-evidence.json')
  $baselineInstallLocation = $baselineInstall.InstallLocationPath
  $installLocation = $baselineInstallLocation
  Assert-X64Pe -Path $baselineInstall.Executable

  Invoke-UpgradePhase `
    -Mode 'baseline-initialize' `
    -Executable $baselineInstall.Executable `
    -ExpectedVersion $ExpectedBaselineVersion `
    -SourceSha $BaselineSourceSha `
    -DiagnosticPath (Join-Path $runRoot 'baseline-diagnostic.json') `
    -ProjectionOutput $baselineProjection

  # Capture before either post-close failure seam so the catch path can prove no bytes changed.
  New-BaselineManifest
  Invoke-FailurePoint -Point 'after-baseline-close'
  Invoke-FailurePoint -Point 'after-manifest-creation'
  Assert-ProfileMatchesBaseline

  Invoke-FailurePoint -Point 'before-candidate-replacement'
  Install-CandidateWithRetry
  $candidateInstall = Get-ExactInstalledApplication -ExpectedVersion $ExpectedCandidateVersion -Stage 'Candidate'
  Write-InstallRegistryEvidence -Install $candidateInstall -Stage 'Candidate' `
    -Path (Join-Path $runRoot 'candidate-registry-evidence.json')
  $installLocation = $candidateInstall.InstallLocationPath
  Assert-UpgradeRegistryIdentity -Baseline $baselineInstall -Candidate $candidateInstall
  Assert-CandidateSignature -Path $candidateInstall.Executable
  Assert-X64Pe -Path $candidateInstall.Executable
  $candidateExecutable = $candidateInstall.Executable

  Invoke-FailurePoint -Point 'after-candidate-replacement'
  Assert-ProfileMatchesBaseline
  Assert-ExactShortcut -CandidateExecutable $candidateExecutable
  Invoke-FailurePoint -Point 'before-candidate-first-launch'

  $script:candidateFirstLaunchStarted = $true
  Invoke-UpgradePhase `
    -Mode 'candidate-first-run' `
    -Executable $candidateExecutable `
    -ExpectedVersion $ExpectedCandidateVersion `
    -SourceSha $CandidateSourceSha `
    -DiagnosticPath (Join-Path $runRoot 'candidate-first-diagnostic.json') `
    -ProjectionOutput $firstProjection `
    -ComparisonProjection $baselineProjection
  $script:candidateFirstLaunchCompleted = $true

  Invoke-UpgradePhase `
    -Mode 'candidate-second-run' `
    -Executable $candidateExecutable `
    -ExpectedVersion $ExpectedCandidateVersion `
    -SourceSha $CandidateSourceSha `
    -DiagnosticPath (Join-Path $runRoot 'candidate-second-diagnostic.json') `
    -ProjectionOutput $secondProjection `
    -ComparisonProjection $firstProjection

  $env:BABYDIARY_E2E_EXECUTABLE = $candidateExecutable
  $env:BABYDIARY_SYNC_E2E_EXECUTABLE = $candidateExecutable
  $env:BABYDIARY_EXPECTED_E2E_ARCH = 'x64'
  Push-Location $repoRoot
  try {
    Invoke-NpmScript -Name 'test:e2e'
    $env:BABYDIARY_SYNC_E2E_UPGRADE_PROFILE = $canonicalProfile
    Invoke-NpmScript -Name 'test:e2e:sync'
  }
  finally {
    Pop-Location
  }
  $success = $true
}
catch {
  Assert-FailureInvariant
  throw
}
finally {
  $env:APPDATA = $originalAppData
  if ($null -eq $originalE2eExecutable) { Remove-Item Env:BABYDIARY_E2E_EXECUTABLE -ErrorAction SilentlyContinue }
  else { $env:BABYDIARY_E2E_EXECUTABLE = $originalE2eExecutable }
  if ($null -eq $originalSyncE2eExecutable) { Remove-Item Env:BABYDIARY_SYNC_E2E_EXECUTABLE -ErrorAction SilentlyContinue }
  else { $env:BABYDIARY_SYNC_E2E_EXECUTABLE = $originalSyncE2eExecutable }
  if ($null -eq $originalSyncE2eUpgradeProfile) { Remove-Item Env:BABYDIARY_SYNC_E2E_UPGRADE_PROFILE -ErrorAction SilentlyContinue }
  else { $env:BABYDIARY_SYNC_E2E_UPGRADE_PROFILE = $originalSyncE2eUpgradeProfile }
  if ($null -eq $originalExpectedE2eArch) { Remove-Item Env:BABYDIARY_EXPECTED_E2E_ARCH -ErrorAction SilentlyContinue }
  else { $env:BABYDIARY_EXPECTED_E2E_ARCH = $originalExpectedE2eArch }
  if ($installationStarted) {
    try { Invoke-VerifiedUninstall -KnownInstallLocation $installLocation }
    catch { $cleanupError = $_ }
  }
  if ($success -and $null -eq $cleanupError) {
    Remove-RunOwnedTempRoot
  }
  else {
    Scrub-DiagnosticSecrets
    Write-Warning "Upgrade diagnostics preserved at: $runRoot"
  }
  if ($null -ne $cleanupError) { throw $cleanupError }
}

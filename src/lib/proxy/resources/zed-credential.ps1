$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AiToolZedCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool Write(ref Credential credential, UInt32 flags);
}
'@
$bytes = [Text.Encoding]::UTF8.GetBytes($request.key)
$pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
  $credential = New-Object AiToolZedCredential+Credential
  $credential.Type = 1
  $credential.TargetName = 'zed:url=' + $request.url
  $credential.UserName = 'Bearer'
  $credential.CredentialBlobSize = $bytes.Length
  $credential.CredentialBlob = $pointer
  $credential.Persist = 2
  if (-not [AiToolZedCredential]::Write([ref]$credential, 0)) { exit 1 }
} finally {
  [Array]::Clear($bytes, 0, $bytes.Length)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
}

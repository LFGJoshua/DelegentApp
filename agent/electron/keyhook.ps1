# Low-level global keyboard hook. Emits one line per key-down: the virtual-key
# code (integer). The agent reads ONLY these codes for timing + backspace stats —
# it never reconstructs typed text. Used by trust.cjs Signal 2.
$ErrorActionPreference = 'Stop'
$code = @"
using System;
using System.Runtime.InteropServices;
public class KeyHook {
  const int WH_KEYBOARD_LL = 13;
  const int WM_KEYDOWN = 0x0100;
  const int WM_SYSKEYDOWN = 0x0104;
  delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
  static HookProc _proc = HookCallback;
  static IntPtr _hook = IntPtr.Zero;
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc cb, IntPtr hMod, uint th);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      int msg = wParam.ToInt32();
      if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
        int vk = Marshal.ReadInt32(lParam);
        Console.Out.WriteLine(vk); Console.Out.Flush();
      }
    }
    return CallNextHookEx(_hook, nCode, wParam, lParam);
  }
  public static void Run() {
    _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
    MSG m; while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
  }
}
"@
Add-Type -TypeDefinition $code
[KeyHook]::Run()

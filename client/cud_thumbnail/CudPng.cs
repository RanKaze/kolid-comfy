// CudPng — 资源管理器右键菜单 "KolidUI > PNG" 的执行体:把 .cud 里保存的
// 画布合成(composite 资产,与缩略图同一份像素)按原名写成 .png,落在 .cud 旁边
// (测试.cud → 测试.png)。解析走 CudDoc.cs,与缩略图提供器共用。
//
// 用法:CudPng [-y] [-q] <file.cud> [...]
//   -y  同名 .png 已存在时直接覆盖,不再询问(菜单只传路径;脚本/自动化用 -y)
//   -q  静默:不弹错误框,失败写 stderr 并回退出码(探针用)
// 退出码:0 成功(含用户选"不覆盖")/ 1 失败 / 2 没有文件参数
using System;
using System.IO;
using System.Runtime.InteropServices;
using Kolid.Cud;

static class CudPng
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    const uint MB_YESNO = 0x4, MB_OK = 0x0, MB_ICONQUESTION = 0x20, MB_ICONERROR = 0x10;
    const int IDYES = 6;

    static int Main(string[] args)
    {
        bool overwrite = false, quiet = false;
        var files = new System.Collections.Generic.List<string>();
        foreach (var a in args)
        {
            if (a == "-y") overwrite = true;
            else if (a == "-q") quiet = true;
            else if (!string.IsNullOrEmpty(a)) files.Add(a);
        }
        if (files.Count == 0) return 2;
        int rc = 0;
        foreach (var f in files) rc = Math.Max(rc, ConvertOne(f, overwrite, quiet));
        return rc;
    }

    static int ConvertOne(string src, bool overwrite, bool quiet)
    {
        string full;
        try { full = Path.GetFullPath(src); }
        catch (Exception e) { return Fail("路径无法解析:\n" + src + "\n\n" + e.Message, quiet); }

        byte[] data;
        try { data = File.ReadAllBytes(full); }
        catch (Exception e) { return Fail("读不到文件:\n" + full + "\n\n" + e.Message, quiet); }

        byte[] png = CudDoc.CompositePng(data);
        if (png == null)
            return Fail(full + "\n\n这个文件里没有画布合成图(composite 资产)。\n旧版工作台存的 .cud、或没有保存过画布的文件会这样。", quiet);

        var dst = Path.ChangeExtension(full, ".png");
        if (File.Exists(dst) && !overwrite)
        {
            int r = MessageBoxW(IntPtr.Zero, "已存在同名图片:\n\n" + dst + "\n\n要覆盖吗?", "KolidUI — 导出 PNG", MB_YESNO | MB_ICONQUESTION);
            if (r != IDYES) return 0;
        }
        try { File.WriteAllBytes(dst, png); }
        catch (Exception e) { return Fail("写不出 PNG:\n" + dst + "\n\n" + e.Message, quiet); }
        return 0;
    }

    static int Fail(string msg, bool quiet)
    {
        if (quiet) Console.Error.WriteLine("CudPng: " + msg.Replace("\n", " "));
        else MessageBoxW(IntPtr.Zero, msg, "KolidUI — 导出 PNG", MB_OK | MB_ICONERROR);
        return 1;
    }
}

// CudThumbnail — Windows 资源管理器缩略图提供器:让 .cud 文件在图标上直接显示
// 画布合成图(就像 jpeg/png 那样)。
//
// .cud 布局与 composite 资产的定位规则在 CudDoc.cs(与右键导出 CudPng.exe 共用)。
//
// 注册:仓库根的 install_windows_integration.bat 用系统自带 csc 编译,再写
// HKCU\Software\Classes 的 per-user COM 注册(不需要管理员):CLSID 指向
// mscoree + CodeBase,.cud 的
// shellex\{E357FCCD-A995-4576-B01F-234630154E96} 指向本 CLSID。
// 注意:绝不能给本 CLSID 写 DisableProcessIsolation=1 —— Win11 的缩略图
// 抽取宿主({AB8902B4-...})会因此拒绝加载,表现为静默失败。
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Reflection;
using Kolid.Cud;

[assembly: AssemblyVersion("1.0.0.0")]

namespace CudThumbnail
{
    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("b824b49d-22ac-4161-ac8a-9916e8fa3f7f")]
    internal interface IInitializeWithStream
    {
        void Initialize(IStream pStream, uint grfMode);
    }

    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("fc4801a3-2ba9-11cf-a229-00aa003d7352")]
    internal interface IInitializeWithFile
    {
        void Initialize([MarshalAs(UnmanagedType.LPWStr)] string pszFilePath, uint grfMode);
    }

    // IID 必须是 e357fccd-a995-4576-... —— 与 shellex 注册键同一个 GUID,
    // 宿主 QI 的就是它(mingw-w64 thumbcache.h: DEFINE_GUID(IID_IThumbnailProvider,
    // 0xe357fccd, 0xa995, 0x4576, ...))。写成 45da 变体会被宿主判 E_NOINTERFACE。
    [ComImport]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    [Guid("e357fccd-a995-4576-b01f-234630154e96")]
    internal interface IThumbnailProvider
    {
        [PreserveSig]
        int GetThumbnail(uint cx, out IntPtr phbmp, out uint pdwAlpha);
    }

    [ComVisible(true)]
    [Guid("D4A7C2F1-6B3E-4E5A-9C48-12F7A0B5D8E3")]
    [ClassInterface(ClassInterfaceType.None)]
    [ProgId("CudThumbnail.Provider")]
    public class CudThumbnailProvider : IInitializeWithStream, IInitializeWithFile, IThumbnailProvider, ICustomQueryInterface
    {
        // 排障用:把宿主对每个 IID 的 QI 照下来(NotHandled = 交还 CLR 默认处理)
        public CustomQueryInterfaceResult GetInterface(ref Guid iid, out IntPtr ppv)
        {
            Log("QI " + iid.ToString("D"));
            ppv = IntPtr.Zero;
            return CustomQueryInterfaceResult.NotHandled;
        }

        private byte[] _bytes;   // 整个文件读进内存:.cud 一般几 MB,无需流式

        // 排障日志:写成多份候选(TEMP / ProgramData / DLL 自身目录)。隔离宿主里
        // %TEMP% 可能被重定向或不可写,单一路径会把日志吞掉。
        private static string[] _logPaths;
        private static string[] LogPaths()
        {
            if (_logPaths != null) return _logPaths;
            var list = new System.Collections.Generic.List<string>();
            try { list.Add(Path.Combine(Path.GetTempPath(), "cud_thumbnail.log")); } catch { }
            try { list.Add(@"C:\ProgramData\cud_thumbnail.log"); } catch { }
            try { list.Add(Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "cud_thumbnail.log")); } catch { }
            _logPaths = list.ToArray();
            return _logPaths;
        }

        private static string _env;
        private static string Env()
        {
            if (_env != null) return _env;
            try
            {
                var p = System.Diagnostics.Process.GetCurrentProcess();
                _env = "pid=" + p.Id + " user=" + Environment.UserName +
                       " temp=" + Path.GetTempPath() + " cmd=" + Environment.CommandLine;
            }
            catch { _env = "env?"; }
            return _env;
        }

        private static void Log(string msg)
        {
            var line = DateTime.Now.ToString("HH:mm:ss.fff") + " t" + System.Threading.Thread.CurrentThread.ManagedThreadId +
                       " " + msg + " | " + Env() + "\r\n";
            foreach (var p in LogPaths()) { try { File.AppendAllText(p, line); } catch { } }
        }

        public CudThumbnailProvider()
        {
            Log("ctor");
        }

        public void Initialize(IStream pStream, uint grfMode)
        {
            Log("Initialize(stream) enter");
            _bytes = null;
            if (pStream == null) { Log("stream null"); return; }
            try
            {
                pStream.Seek(0, 0, IntPtr.Zero);
                using (var ms = new MemoryStream())
                {
                    var buf = new byte[65536];
                    var cb = Marshal.AllocCoTaskMem(sizeof(int));
                    try
                    {
                        while (true)
                        {
                            pStream.Read(buf, buf.Length, cb);
                            int read = Marshal.ReadInt32(cb);
                            if (read <= 0) break;
                            ms.Write(buf, 0, read);
                        }
                    }
                    finally { Marshal.FreeCoTaskMem(cb); }
                    _bytes = ms.ToArray();
                }
            }
            catch (Exception e) { Log("stream read failed: " + e.Message); _bytes = null; }
        }

        public void Initialize(string pszFilePath, uint grfMode)
        {
            Log("Initialize(file) enter: " + pszFilePath);
            _bytes = null;
            try { _bytes = File.ReadAllBytes(pszFilePath); } catch (Exception e) { Log("file read failed: " + e.Message); _bytes = null; }
        }

        public int GetThumbnail(uint cx, out IntPtr phbmp, out uint pdwAlpha)
        {
            Log("GetThumbnail enter, cx=" + cx + ", bytes=" + (_bytes == null ? -1 : _bytes.Length));
            int hr = RenderThumbnail(_bytes, cx, out phbmp, out pdwAlpha);
            Log("GetThumbnail exit hr=0x" + hr.ToString("X"));
            return hr;
        }

        // 托管面测试入口(ClassInterfaceType.None 下不进 COM 面):直接对字节数据渲染
        public int RenderThumbnail(byte[] data, uint cx, out IntPtr phbmp, out uint pdwAlpha)
        {
            phbmp = IntPtr.Zero;
            pdwAlpha = 0;   // WTSAT_UNKNOWN
            try
            {
                if (data == null || data.Length < 8) return unchecked((int)0x80004005); // E_FAIL
                int want = (int)Math.Max(16u, Math.Min(cx, 1024u));
                using (var bmp = ExtractComposite(data))
                {
                    if (bmp == null) return unchecked((int)0x80004005);
                    using (var thumb = Scale(bmp, want))
                    {
                        phbmp = thumb.GetHbitmap();
                        pdwAlpha = 2;   // WTSAT_ARGB
                        return 0;       // S_OK
                    }
                }
            }
            catch (Exception e) { Log("RenderThumbnail exception: " + e); return unchecked((int)0x80004005); }
        }

        // ---- .cud 解析:定位 composite 资产(见 CudDoc.cs)并解码 ----
        internal static Bitmap ExtractComposite(byte[] data)
        {
            byte[] png = CudDoc.CompositePng(data);
            if (png == null) return null;
            using (var ms = new MemoryStream(png))
            using (var img = Image.FromStream(ms))
                return new Bitmap(img);
        }

        private static Bitmap Scale(Bitmap src, int cx)
        {
            double scale = Math.Min((double)cx / Math.Max(1, src.Width),
                                    (double)cx / Math.Max(1, src.Height));
            if (scale > 1.0) scale = 1.0;   // 不放大
            int tw = Math.Max(1, (int)Math.Round(src.Width * scale));
            int th = Math.Max(1, (int)Math.Round(src.Height * scale));
            var dst = new Bitmap(tw, th, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(dst))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.DrawImage(src, new Rectangle(0, 0, tw, th));
            }
            return dst;
        }
    }
}

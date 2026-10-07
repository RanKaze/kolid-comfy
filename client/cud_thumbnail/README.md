# .cud 缩略图提供器(Windows 资源管理器)

让 Windows 11/10 在资源管理器里像 jpeg/png 一样直接把 `.cud` 文件的图标显示成
**画布合成图**(保存那一刻的画布内容,blend_node.html 的 buildCudBlob 会把它作为
`role='composite'` 的资产存进文件,这里只读它,不解析图层)。

## 安装

双击 `install.bat`(或命令行运行)。它做两件事:

1. 用系统自带的 .NET Framework csc 编译出 `CudThumbnail.dll`;
2. 写 **HKCU\Software\Classes** 的 per-user COM 注册(不需要管理员):
   CLSID → mscoree + CodeBase 指向本目录的 DLL,`.cud` 与 `cud.document` 两级的
   `shellex\{E357FCCD-A995-4576-B01F-234630154E96}` 指向该 CLSID,并调
   `SHChangeNotify` 让外壳立刻刷新关联。

如果图标没有立刻刷新,重启 explorer.exe(任务管理器里重启 Windows 资源管理器)
或注销重登一次;已经缓存过旧图标的文件可能要复制/改名一个新副本才会重新渲染。

## 卸载

双击 `uninstall.bat`:删掉注册键并删除编译出的 DLL。`.cud` 文件本身不受影响。

## 实现

`CudThumbnail.cs` — 一个实现 `IInitializeWithStream` / `IInitializeWithFile` /
`IThumbnailProvider` 的 COM 可见类(纯 .NET Framework,无第三方依赖):

- 读 `'CUD1'` magic + uint32 LE 头长 + JSON 头,按 `assets` 顺序定位
  `role='composite'` 的 PNG,解码后高质量缩到请求尺寸,以 32bpp ARGB 返回;
- 文件头不对/没有 composite/解码失败 → 返回 E_FAIL,资源管理器回退通用图标。

## 已知边界

- 只支持 64 位的缩略图宿主(dllhost);x64 Windows 的资源管理器缩略图默认就是它。
- 注册脚本优先用 `Microsoft.NET\Framework64\v4.0.30319\mscoree.dll`,新版 Win11
  没有的话回退 `System32\mscoree.dll`。
- 老版本工作台存的 `.cud`(无 composite 资产)取不到缩略图,回退通用图标。

## 排障要点(Win11 的三个坑,踩过)

1. **接口 IID 必须是 `{E357FCCD-A995-4576-B01F-234630154E96}`**——它同时是 shellex
   注册键名和 `IThumbnailProvider` 的接口 IID(mingw-w64 `thumbcache.h` 的
   `DEFINE_GUID(IID_IThumbnailProvider, 0xe357fccd, 0xa995, 0x4576, …)`)。
   类里接口的 `[Guid]` 若写成别的变体,宿主 QueryInterface 拿不到接口,表现为
   静默回退通用图标。
2. **绝不能给本 CLSID 或 `{E357FCCD-…-4576-…}` 写 `DisableProcessIsolation`**。
   Win11 的缩略图抽取宿主(`DllHost.exe /Processid:{AB8902B4-09CA-4BB6-B78D-A8F59079A8D5}`,
   "Thumbnail Cache Out of Proc Server")会因此拒绝加载处理器,同样是静默失败。
   注册脚本每次运行都会把这个值清掉。
3. 抽取发生在隔离宿主里,**%TEMP% 可能被重定向**,排障日志因此写三份:
   `%TEMP%\cud_thumbnail.log`、`C:\ProgramData\cud_thumbnail.log`、本目录
   `cud_thumbnail.log`。日志会记录每次激活的 ctor、宿主对每个 IID 的
   QueryInterface、Initialize 与 GetThumbnail 的返回码。

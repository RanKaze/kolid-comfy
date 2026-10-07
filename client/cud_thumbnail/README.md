# .cud 缩略图提供器与右键导出(Windows 资源管理器)

让 Windows 11/10 在资源管理器里像 jpeg/png 一样直接把 `.cud` 文件的图标显示成
**画布合成图**(保存那一刻的画布内容,blend_node.html 的 buildCudBlob 会把它作为
`role='composite'` 的资产存进文件,这里只读它,不解析图层)。

另附右键菜单 **KolidUI > PNG**:把同一份画布合成按原名写成 `.png` 落在 `.cud`
旁边(`测试.cud` → `测试.png`,已存在同名图片时会先问是否覆盖)。Win11 上它同时
出现在**现代(一级)右键菜单**和经典菜单("显示更多选项")里,两条路走同一个
`CudPng.exe`(现代菜单见下面"Win11 一级菜单"一节)。

## 安装 / 卸载

用仓库根的 **`install_windows_integration.bat`** / **`uninstall_windows_integration.bat`**
(双击或命令行运行),不用进本目录。安装脚本做四件事:

1. 用系统自带的 .NET Framework csc 编译出 `CudThumbnail.dll` 与 `CudPng.exe`
   (编译前会先关掉 Explorer 的缩略图宿主,免得 DLL 被占用);
2. 写 **HKCU\Software\Classes** 的 per-user COM 注册(不需要管理员):
   CLSID → mscoree + CodeBase 指向本目录的 DLL,`.cud` 与 `cud.document` 两级的
   `shellex\{E357FCCD-A995-4576-B01F-234630154E96}` 指向该 CLSID;
3. 写双击关联(`cud.document\shell\open\command` → 仓库根的 `Kolid Desktop.exe`)
   与右键菜单(`cud.document\shell\KolidUI`,纯注册表级联,无常驻组件),
   并调 `SHChangeNotify` 让外壳立刻刷新关联;
4. Win11 现代(一级)菜单的构建 + 打包 + 安装(需要一次 UAC;缺 MSYS2 g++
   或网络时自动跳过,不影响上面三条,见下一节)。

卸载脚本幂等(没装过也能跑):清掉 HKCU 全部注册键(含 Explorer `FileExts\.cud`
里指向 `cud.document` 的打开方式残留,不动用户的 OpenWithList 历史),删掉编译出的
`CudThumbnail.dll` 与 `CudPng.exe`;若检测到旧脚本写过的机器级(HKLM)遗留,会请求
提权一并清掉;还会提权移除 Win11 现代菜单的 Appx 包(同样一次 UAC,拒绝则跳过,
其余清理照做)。`.cud` 文件本身不受影响。

本目录的 `register*.ps1` / `unregister.ps1` 是引擎脚本,一般只被上述 bat 调用;
`win11_menu\` 下的三个 ps1 也只由这两个 bat 调(见下节)。

## Win11 一级菜单(Win11 ≥ 22000 才装)

Win11 的现代右键菜单**不读注册表级联**,所以 `shell\KolidUI` 那条只能出现在
经典菜单("显示更多选项")里;要进一级菜单,必须是一个打包应用(MSIX +
`IExplorerCommand`)。`win11_menu\` 是这条路的完整实现:

- `KolidCtxMenu.cpp` → `KolidCtxMenu.dll`:实现 `IExplorerCommand` 的 STA COM
  组件;对非 `.cud` 文件在 `GetState` 里隐藏(菜单清单的 ItemType 只认
  `*` / `Directory` / `Directory\Background`,按扩展名写 `.cud` 不会被匹配);
  菜单图标走 `GetIcon`——返回 `icon.ico` 的文件路径,先找 DLL 同目录(包根),
  再退 `..\..\`(仓库松散布局),都不在则回退包内路径(外壳会显示通用占位图)。
- `KolidCtxMenuStub.cpp` → `KolidCtxMenuStub.exe`:清单要求
  `Application@Executable` 必须是 .exe 的占位,正常路径不会被启动。
- `AppxManifest.xml`:唯一来源。`com:SurrogateServer` 把 DLL 声明为系统代理内
  COM 服务,`desktop5:Verb` 把命令挂进文件右键;版本号与发布者由打包脚本注入。
- `install_win11_menu.ps1` / `uninstall_win11_menu.ps1` / `appx_child.ps1`:
  构建、打包、提权安装/卸载。退出码:0 已安装 / 1 失败 / 3 跳过 / 4 UAC 被拒。

外部依赖两条,缺任一条自动跳过(退出码 3,其余三件功能不受影响):

- **MSYS2 的 g++**(优先 `C:\msys64\ucrt64\bin\g++.exe`,也认 mingw64 与 PATH):
  编 DLL 与 Stub 用;必须加 `-static`——动态依赖 libwinpthread-1.dll 会让代理
  激活报 0x8007007E。
- **makeappx**:首次运行从 nuget 下载 Windows SDK BuildTools(约 22.7MB),抽出
  最小可运行文件集(约 4.8MB)缓存到 `win11_menu\tools\`(已 gitignore),之后
  离线复用。注意 makeappx.exe 不能单独拷出来跑:它的嵌入清单依赖同目录的
  `Microsoft.Windows.Build.Appx.AppxPackaging.dll` / `OpcServices.dll` 两个 SxS
  程序集(连 .manifest 共 5 个文件),缺了报"并行配置不正确"。

打包细节(踩过的坑,改脚本前先读 `AppxManifest.xml` 顶部注释):

- `icon.ico`(仓库的 `client\icon.ico`,多尺寸 16–256)每次打包都会装进包根:
  一级菜单对每条命令都调 `GetIcon` 取图标,返回一条不存在的路径 = 显示通用白纸
  占位图(踩过)。包目录对 `BUILTIN\Users` 有读权限,所以把包内路径直接交给
  资源管理器即可,不需要另找目录落图标文件。
- 版本号每次安装按当前时间注入 `<yy-2000>.<MMdd>.<HHmm>.<ss>`(如
  `26.1008.213.5`):每段必须 ≤65535 且**禁前导零**,否则安装报 0x80080204;
  数值递增 = 原地升级,同版本重装报 0x80073CFB。
- 未签名包:发布者带 OID 标记(`CN=Kolid-Comfy, OID.2.25.…=1`),用
  `Add-AppxPackage -Path <msix> -AllowUnsigned` 提权安装(本机开发者模式开启下
  实测通过;策略禁止侧载的机器会失败)。
- 卸载保留 `tools\` 缓存与编译产物;想回收这约 5MB,删掉 `win11_menu\tools\`
  即可,下次安装会重新下载。

改动后用两台探针复验:`F:\Harness\kolid-comfy\cudmenu_modern_e2e.ps1`
(现代菜单 9/9)与 `ctxmenu_e2e.py`(经典菜单 14/14,经"显示更多选项"往返,
导航用 UIA `HasKeyboardFocus` 逐项回读——手数 Down 会随已装扩展变化而落错项)。

如果图标没有立刻刷新,重启 explorer.exe(任务管理器里重启 Windows 资源管理器)
或注销重登一次;已经缓存过旧图标的文件可能要复制/改名一个新副本才会重新渲染。

## 实现

`CudDoc.cs` — `.cud` 里 composite 资产的定位与取出:读 `'CUD1'` magic +
uint32 LE 头长 + JSON 头,按 `assets` 的 id 顺序累加 length 找偏移,取
`role='composite'` 那段 PNG 的原始字节;下面两个产物共用这一份解析(偏移规则
只此一处,避免两份实现漂移)。

`CudThumbnail.cs` — 一个实现 `IInitializeWithStream` / `IInitializeWithFile` /
`IThumbnailProvider` 的 COM 可见类(纯 .NET Framework,无第三方依赖):把
composite 解码后高质量缩到请求尺寸,以 32bpp ARGB 返回;文件头不对/没有
composite/解码失败 → 返回 E_FAIL,资源管理器回退通用图标。

`CudPng.cs` — 命令行 `CudPng [-y] [-q] <file.cud> [...]`(-y 覆盖不询问,
-q 静默回退出码,供探针用)。菜单项只传路径;`测试.cud` → `测试.png`。

## 已知边界

- 只支持 64 位的缩略图宿主(dllhost);x64 Windows 的资源管理器缩略图默认就是它。
- 注册脚本优先用 `Microsoft.NET\Framework64\v4.0.30319\mscoree.dll`,新版 Win11
  没有的话回退 `System32\mscoree.dll`。
- 老版本工作台存的 `.cud`(无 composite 资产)取不到缩略图,回退通用图标。
- Win11 一级菜单只在 build ≥ 22000 的 Win11 上装;Win10、缺 MSYS2 g++ 或首次
  下载失败时自动跳过该条,其余功能（缩略图/双击/经典菜单）不受影响。

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

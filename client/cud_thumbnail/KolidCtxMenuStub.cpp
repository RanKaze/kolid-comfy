// KolidCtxMenuStub — win11_menu/AppxManifest.xml 里 Application@Executable 的占位。
//
// 资源管理器右键菜单的真实入口是 com:SurrogateServer 激活的 KolidCtxMenu.dll
// (见同目录清单);App@Executable 只被清单校验要求是 .exe,不会被正常路径启动
// (VisualElements 标了 AppListEntry="none",不出现在开始菜单/应用列表)。
//
// 构建: g++ -O2 -s -mwindows -o win11_menu/KolidCtxMenuStub.exe KolidCtxMenuStub.cpp

#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
    return 0;
}

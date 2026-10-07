// .cud 文件里 composite 资产的定位与取出 —— 缩略图提供器(CudThumbnail.dll)
// 与右键导出(CudPng.exe)共用这一份,payload 偏移规则只此一处。
//
// .cud 布局(见 blend_node.html buildCudBlob):
//   'CUD1' | uint32 LE headerLen | JSON header | payload
//   payload = header.assets 按 id 顺序连放的 PNG;composite 资产(role='composite')
//   就是保存那一刻的画布合成。这里只读它,不解析图层。
using System;
using System.Text;
using System.Web.Script.Serialization;

namespace Kolid.Cud
{
    public static class CudDoc
    {
        // 成功返回 composite 资产的 PNG 原始字节(整段拷贝);任何一步对不上返回 null。
        public static byte[] CompositePng(byte[] data)
        {
            if (data == null || data.Length < 8 || data[0] != 'C' || data[1] != 'U' || data[2] != 'D' || data[3] != '1')
                return null;
            int headerLen = BitConverter.ToInt32(data, 4);
            if (headerLen <= 0 || headerLen > 128 * 1024 * 1024 || 8 + headerLen > data.Length)
                return null;
            string json = Encoding.UTF8.GetString(data, 8, headerLen);
            var ser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            var header = ser.Deserialize<Header>(json);
            if (header == null || header.assets == null || header.assets.Length == 0)
                return null;

            // composite 资产:优先 role == 'composite',否则用 header.composite 的 id
            Asset target = null;
            int compositeId = -1;
            if (header.composite is int) compositeId = (int)header.composite;
            else if (header.composite != null) int.TryParse(header.composite.ToString(), out compositeId);
            foreach (var a in header.assets)
            {
                if (a != null && a.role == "composite") { target = a; break; }
            }
            if (target == null && compositeId >= 0)
            {
                foreach (var a in header.assets)
                    if (a != null && a.id == compositeId) { target = a; break; }
            }
            if (target == null || target.length < 8) return null;

            // payload 里资产的偏移 = 前面所有资产的 length 之和(按 id 顺序连放)
            int offset = 8 + headerLen;
            foreach (var a in header.assets)
            {
                if (a == null || a.id == target.id) continue;
                if (a.id < target.id || (target.id < 0 && a.role != "composite"))
                    offset += a.length;
            }
            if (offset + target.length > data.Length) return null;

            // 取出来的必须是 PNG 本体(8 字节签名),否则按"没有合成图"处理
            if (data[offset] != 0x89 || data[offset + 1] != 0x50 || data[offset + 2] != 0x4E || data[offset + 3] != 0x47)
                return null;
            var png = new byte[target.length];
            Buffer.BlockCopy(data, offset, png, 0, target.length);
            return png;
        }

        internal class Header
        {
            public Asset[] assets;
            public object composite;
        }

        internal class Asset
        {
            public int id;
            public string role;
            public int w;
            public int h;
            public int length;
        }
    }
}

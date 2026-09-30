抖音视频解析工具（Windows 网页版）

使用方法：
1. 双击“VideoInsightMVP.exe”。
2. 程序会在后台启动本地服务，并自动打开浏览器。
3. 首次使用，点击右上角“接口设置”，填写火山方舟 API Key、模型 ID 和 TikHub API Key。
火山方舟我用的 seed 2.1 lite 完全够用 API Key 获取网址：https://exp.volcengine.com/ark/gen_chat?model=doubao-seed-2-1-lite-260915
TikHub API Key 获取网址：https://tikhub.io/zh
4. 粘贴抖音作品链接，点击“开始分析”。

数据保存位置：
%LOCALAPPDATA%\VideoInsightMVP\data

说明：
- 程序仅监听 127.0.0.1，不向局域网开放。
- 视频使用 TikHub 返回的临时直链交给模型理解，不会下载或保存视频文件。
- API Key 和分析结果只保存在当前 Windows 用户的本地应用数据目录。
- 如果浏览器未自动打开，可再次双击程序。

继续同一个 narration-story 项目，完成第一人称故事样片、剪辑与实际成片审查。此前 read PNG 把二进制当文本导致 Host 存储报错，现已部署图片读取与历史保存修复；请重新 read 实际 reference.png，验证可见后继续。现有生成均成功，不要重复生成声音或图片。

先检查 /home/user/narration-story/ 下已保存的结果，读取原版 narration-led-film 和相关 MediaKit/VFS Skill。master.wav 是唯一连续主音轨：seed-audio-1.0，task audio_4494b425-909e-49e6-8944-280cca0d3d28，Resource 103932，27 秒。reference.png 是 gpt-image2，task 06514068-eda6-492d-b328-3f5257041efb，Resource 103933，2048×1152。不要根据此消息覆盖原始记录，应核对磁盘证据。

声音的独立转录与原稿字词一致、末句完整，主叙事可继续。几次模型听审对雨声和音乐起点意见不一，保留为声音设计质量疑点，不标全通过。本次基础设施验收不因此重做已可听懂的主音轨。

补存 phase1.json、phase1-review.md，并从供应商原始字幕与27秒实际主音轨建立画面时间线。可用划分为0–14秒和14–27秒：灯亮词在12.64–13.28秒，邻居挥手段在16.40–18.24秒，最后“惦记”在25.36–25.76秒，保留27秒完整结尾。以实际文件为准，供应商逐词时间与Gemini粗时间需区分。

本阶段最多提交2次 Seedance 2.5 视频生成，不重发状态不明的任务。先阅读精确 schema 和 generate/resource 文档，用 FFmpeg 从 master.wav 按实际分段裁出14秒与13秒的声音片段，用 vfs-cli resource create --type audio 注册，每次上传/提交即时保存 resource/task id。所有VFS调用保持测试地址 pre-pixel-director.creativefitting.cn，视频用 seedance-2.5、720p、16:9，分别14秒和13秒，通过 @resource 同时引用参考图和对应音轨片段。保存 dry-run、提示词、请求与查询结果，使用 --async 后 query 原任务。可并发提交这两个独立段落，但不能重复提交。

先看参考图，明确它锁定人物身份、米色衣服、同一个纸箱、旧巷空间；参考中门灯已亮，所以第一段提示词需明确开始为未亮状态，12.6秒附近亮起，不能把已亮的参考帧当开头状态。第一段建立搬家离别、停步与灯亮；第二段让邻居从同一木门出现挥手，女人抬头看到、表情由迟疑转为被惦记的暖意，再完整收尾。人物通过动作和目光回应，禁止对画外旁白做现场口型；明确邻居位置、谁看谁。让真实视频承担运动和表演，不以静图代替两个视频。

下载真实结果并保留源素材，探测实际时长，抽帧查看人物和关键事件。使用现有 MediaKit/FFmpeg 以连续 master.wav 剪辑：关闭全部视频伴生音频，画面顺接或做有依据的转场，保证最终27秒、无双重人声、不截断尾字。保存源入出点与成片位置、剪辑命令/项目、ffprobe结果。无需为了装饰加入片头或额外旁白。

最终将实际 final.mp4 交 Gemini 3.8 Flash 做 native Agentic Video Understanding。使用已经更新的 /home/user/auto-story-e2e/video_analysis.py，明确 --processing agentic --execution sync；后台模式当前存在 provider Files 路由错误，已验证同步可返回成对 processing_call/result。以 --question 提供旁白和上述关键转折，要求审看完整27秒、人物连续、灯亮与挥手的可见因果、纯画外音、字幕/音画时机、句末完整。保存实际成片SHA/时长、processing_call.id/processing_result.call_id严格配对、上传删除结果和审片文字。API运行成功不等于内容全部合格；必须回查原始素材、抽帧与音轨，尤其注意审片模型可能幻听，不采信没有证据的细节。

可以用已有素材做必要的局部剪辑修正；每次改变成片后重新审看最终文件。本回合不追加第3次视频生成；如2次已成功但仍缺关键事件，保留当前成片和具体缺陷。最终写 final-report.json 和 final-review.md，列实际模型/任务/资源/路径、音轨时间线、剪辑和真实审查结果、已解决及残留项。最后结束本回合并报告可播放文件路径。

请在当前 auto-story sandbox 中用已装备的原版 narration-led-film 制作一条中文第一人称故事验收样片。最终目标是可播放、听懂的故事短片；本回合先完成声音与参考图阶段，保存检查点后停下，下一回合继续视频和成片。

先读取 narration-led-film、vfs-cli、video-analysis 以及需要的 MediaKit 原版 Skill 和引用文档。验证 vfs-cli version 为 v0.3.14、测试地址为 pre-pixel-director.creativefitting.cn，再按实际模型 schema 调用。API、密钥和 OSS 环境已配置；不得输出密钥或改用正式环境。无需创建或修改任何已有 VFS 项目；本次只创建自己的验收素材，标题/说明用 auto-story-narration-e2e 标识。

使用这段原创虚构旁白，女性第一人称，约 25–30 秒，16:9，写实温暖风格：

那天，我拎着最后一只纸箱，走出住了十年的老巷。雨里，门口那盏坏了很久的灯忽然亮了。我抬头，邻居朝我挥了挥手。原来，离开之前，我才发现，自己一直被人惦记。

声音要求：成人女性自然画外讲述，雨声很轻，开始略有离别感，灯亮之后转为温暖的稀疏钢琴，音乐和环境声不能盖住旁白。没有额外现场对白，不读出导演说明。由 Seed Audio 1.0 Multilingual 一次组织完整旁白、音乐、环境声。

执行边界：本回合最多提交 1 次 seed-audio-1.0 声音生成和 1 次 gpt-image2 图片生成。使用 --async 先保存 task_id 再 query，超时查询原任务，不能因不确定而重复提交。图片作为下一阶段两个视频镜头共用的人物和场景参考：三十岁左右黑发中国女性、米色外套、一个纸箱、雨夜旧巷和暖色门灯；人物不正对镜头说话。使用实际返回的 Resource 和可访问地址下载产物。

把所有资料放入 /home/user/narration-story/：旁白原稿、完整声音提示词、图片提示词、提交与查询结果、task/resource IDs、master.wav、reference.png、供应商原始字幕。用 ffprobe/MediaKit 确认实际音轨时长，读取字幕中的真实时间点。

先独立听审音轨再比对原稿；可使用已上传的 /home/user/auto-story-e2e/audio_analysis.py（先阅读代码和 --help）通过 Gemini 3.8 Flash 提交实际音频。记录漏词/加词、可懂度、雨声与音乐、句尾完整性，并看实际参考图。若素材存在问题，按实际结果报告，不伪造通过也不擅自追加生成。

最后保存 /home/user/narration-story/phase1.json 和 phase1-review.md：实际模型、任务和资源 ID、文件路径、实测时长、字幕时间线、Gemini 听审文件与判定、下一阶段按实音轨划分的两个视频段落。保存后结束本回合，等待继续。不要在这个回合提交视频。

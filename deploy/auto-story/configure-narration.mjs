#!/usr/bin/env node
// Configure the existing Agent's test workflow; credentials stay server-side.
const agentId = process.argv[2];
if (!agentId) throw new Error('Usage: configure-narration.mjs <agent-id>');
const base = (process.env.OMA_API_URL || 'https://agentry.welltop.tech/api').replace(/\/$/, '');
const auth = process.env.OMA_BEARER_TOKEN ? { authorization: `Bearer ${process.env.OMA_BEARER_TOKEN}` } : { 'x-api-key': process.env.OMA_API_KEY };
if (!Object.values(auth)[0]) throw new Error('Set OMA_API_KEY or OMA_BEARER_TOKEN privately');
async function request(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`OMA configuration HTTP ${response.status}`);
  return response.json();
}
const agent = await request(`/v1/agents/${agentId}`);
const skills = (await request(`/v1/agents/${agentId}/skills`)).data;
const story = skills.find(skill => skill.name === 'narration-led-film');
if (!story) throw new Error('Equip the original narration-led-film Skill first');
const block = `<!-- auto-story-narration:start -->
第一人称故事与旁白驱动短片优先读取 /skills/${story.id}/SKILL.md，遵循原版 narration-led-film 流程。
当前配置为 VFS 测试环境。所有 VFS 生成通过 vfs-cli：声音用 generate audio --model seed-audio-1.0；参考图用 generate image --model gpt-image2；画面用 generate video --model seedance-2.5。构造请求前阅读该模型 schema。模型与地域不自动替换。
先生成连续原音轨，保存原始音频和供应商字幕，用实际音轨时间点组织画面。声音生成单次最多120秒；更长故事先拆分完整叙事段落并说明连续性策略。音轨片段通过 resource create --type audio 注册后，用 @resource 引用传给视频生成。纯旁白人物不对画外音做现场口型。
Gemini 使用官方 google-genai SDK 和 gemini-3.8-flash。google-genai 2.22.0 创建 Client 后设置 client.interactions.sdk_configuration.retry_config=None，关闭不确定提交的SDK隐式重试。将实际音频作为 audio 输入独立转录、听审并与原稿核对；音视频均使用同步 Interactions（background:false、store:false），WAV MIME 为 audio/wav，当前后台媒体路由不可用。成片以 video 输入 processing:"agentic" 审看，保存并核对非空 processing_call.id 与 processing_result.call_id 配对。同步已完成且 store:false 时 interaction id 可以为空。长任务等到最终完成再清理上传。普通视频分析不能标为 Agentic 验收。
所有生产记录保存在 /home/user 下项目目录：提示词、task_id、resource_id、原始音轨、字幕、素材、真实时间线、剪辑与审片记录。提交后先保存 task_id；超时先 query 原任务，状态未知时不要自动重发收费生成。剪辑使用连续原音轨，移除生成视频伴生音频。最终结论对应实际可播放文件，按用户本次制作范围执行。
<!-- auto-story-narration:end -->`;
const system = agent.system.replace(/\n?<!-- auto-story-narration:start -->[\s\S]*?<!-- auto-story-narration:end -->\n?/g, '').trim() + '\n\n' + block;
await request(`/v1/agents/${agentId}`, {
  system,
  sandbox: { ...agent.sandbox, env: { ...agent.sandbox?.env,
    VFS_PIXEL_DIRECTOR_URL: 'https://pre-pixel-director.creativefitting.cn',
    VFS_YJS_URL: 'https://pre-api.welltop.tech',
  } },
});
console.log(JSON.stringify({ agentId, model: agent.model, storySkillId: story.id, vfsEnvironment: 'test', configured: true }));

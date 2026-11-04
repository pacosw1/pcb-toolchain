import { query } from '@anthropic-ai/claude-agent-sdk'

const t0 = Date.now()
const q = query({
  prompt: 'Reply with the single word: pong',
  options: {
    cwd: '/Users/pacosw/code/iot-lab',
    allowedTools: ['Read'],
    permissionMode: 'dontAsk',
    settingSources: ['project'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Be brief.' },
    stderr: (d) => process.stderr.write('[cli] ' + d)
  }
})
for await (const m of q) {
  const t = ((Date.now() - t0) / 1000).toFixed(1)
  if (m.type === 'assistant') console.log(t, 'assistant', JSON.stringify(m.message.content).slice(0, 200))
  else if (m.type === 'result') console.log(t, 'result', m.subtype, m.total_cost_usd, m.result?.slice?.(0, 100))
  else console.log(t, m.type, m.subtype ?? '', m.type === 'system' ? JSON.stringify({ apiKeySource: m.apiKeySource, model: m.model }) : '')
}

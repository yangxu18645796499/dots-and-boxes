// AI 接入模块：BYOK（自带密钥）浏览器直连 OpenAI 兼容接口。
// API Key 仅保存在当前浏览器的 localStorage，只直连用户填写的 API 地址，
// 永远不会经过本游戏的服务器。
import type { PlayerSymbol, RoomState } from './App';
import { GAME_RULES } from './gameRules';

export type AiConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  intervalMs: number;
  useVision: boolean;
};

const AI_CONFIG_KEY = 'dots_and_boxes_ai_v1';

export const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  intervalMs: 1000,
  useVision: false,
};

export function loadAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY);
    if (!raw) {
      return { ...DEFAULT_AI_CONFIG };
    }

    return { ...DEFAULT_AI_CONFIG, ...(JSON.parse(raw) as Partial<AiConfig>) };
  } catch {
    return { ...DEFAULT_AI_CONFIG };
  }
}

export function saveAiConfig(config: AiConfig): void {
  try {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // 隐私模式等场景下不可用，忽略（本次会话仍可内存使用）
  }
}

export function allEdges(rows: number, cols: number): string[] {
  const edges: string[] = [];
  for (let r = 0; r <= rows; r += 1) for (let c = 0; c < cols; c += 1) edges.push(`h-${r}-${c}`);
  for (let r = 0; r < rows; r += 1) for (let c = 0; c <= cols; c += 1) edges.push(`v-${r}-${c}`);
  return edges;
}

// 规则 + 当前局面 → 提示词。规则部分与"查看规则"弹窗同源（GAME_RULES）。
export function buildPrompt(room: RoomState, me: PlayerSymbol, valid: string[]): string {
  const rulesText = GAME_RULES.map(
    (section) => `【${section.title}】\n${section.items.map((item) => `- ${item}`).join('\n')}`,
  ).join('\n');
  const claimed = Object.entries(room.claimedEdges)
    .map(([edge, owner]) => `${edge}(${owner})`)
    .join(', ');
  const claimedText = claimed || '无';
  const boxes = Object.entries(room.claimedBoxes)
    .map(([box, owner]) => `${box}(${owner})`)
    .join(', ');
  const boxesText = boxes || '无';

  return [
    `你在玩点格棋（Dots and Boxes），棋盘 ${room.boardRows}x${room.boardCols}，你是 ${me} 方。请只依据以下信息行动。`,
    '',
    '== 游戏规则 ==',
    rulesText,
    '',
    '== 当前局面 ==',
    `回合：第 ${room.roundNumber} 局，状态：${room.status}`,
    `我方已得盒子：${room.scores[me]}；对方已得盒子：${room.scores[me === 'A' ? 'B' : 'A']}`,
    `已占边：${claimedText}`,
    `已归属盒子：${boxesText}`,
    `当前轮到：${room.currentTurn} 方（就是你）`,
    `你可选择的边：${valid.join(', ')}`,
    '',
    '== 行动要求 ==',
    '优先补全能得盒的边；避免送给对方三边盒（即让对方一步成盒）。',
    '只输出一个 JSON 对象：{"edge":"<从你可选择的边中选一条>"}，不要输出任何其他内容。',
  ].join('\n');
}

export async function requestAiMove(
  config: AiConfig,
  prompt: string,
  imageDataUrl: string | null,
): Promise<string> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: 'text', text: prompt },
    ];
    if (imageDataUrl) {
      content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
    }

    const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content }],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`API 返回 ${res.status}`);
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    window.clearTimeout(timer);
  }
}

// 解析模型回复中的边：优先取 JSON 字段，退化为文本中的第一个匹配
export function parseEdgeReply(text: string, valid: string[]): string | null {
  const jsonMatch = text.match(/"(?:edge|edgeId|edge_id)"\s*:\s*"([hv]-\d+-\d+)"/i);
  const looseMatch = text.match(/\b([hv]-\d+-\d+)\b/);
  const edge = jsonMatch?.[1] ?? looseMatch?.[1] ?? null;
  return edge && valid.includes(edge) ? edge : null;
}

// 把棋盘绘制成 PNG（供视觉模型"看"局面）：点阵 + 已占边（蓝/橙）
export function drawBoardImage(room: RoomState): string | null {
  try {
    const cell = 56;
    const pad = 26;
    const canvas = document.createElement('canvas');
    canvas.width = pad * 2 + room.boardCols * cell;
    canvas.height = pad * 2 + room.boardRows * cell;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const colors: Record<PlayerSymbol, string> = { A: '#1677ff', B: '#ff6b35' };
    const x = (c: number) => pad + c * cell;
    const y = (r: number) => pad + r * cell;

    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    Object.entries(room.claimedEdges).forEach(([edge, owner]) => {
      const [, orientation, r, c] = edge.split('-');
      ctx.strokeStyle = colors[owner];
      ctx.beginPath();
      if (orientation === 'h') {
        ctx.moveTo(x(Number(c)), y(Number(r)));
        ctx.lineTo(x(Number(c) + 1), y(Number(r)));
      } else {
        ctx.moveTo(x(Number(c)), y(Number(r)));
        ctx.lineTo(x(Number(c)), y(Number(r) + 1));
      }
      ctx.stroke();
    });

    ctx.fillStyle = '#1c2333';
    for (let r = 0; r <= room.boardRows; r += 1) {
      for (let c = 0; c <= room.boardCols; c += 1) {
        ctx.beginPath();
        ctx.arc(x(c), y(r), 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

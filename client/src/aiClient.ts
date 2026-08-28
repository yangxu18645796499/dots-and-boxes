// AI 接入模块：BYOK（自带密钥）浏览器直连 OpenAI 兼容接口。
// API Key 仅保存在当前浏览器的 localStorage，只直连用户填写的 API 地址，
// 永远不会经过本游戏的服务器。
import type { PlayerSymbol, RoomState } from './App';
import { AI_STRATEGY, GAME_RULES } from './gameRules';

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

// 一个盒子的四条边
function boxEdges(r: number, c: number): string[] {
  return [`h-${r}-${c}`, `h-${r + 1}-${c}`, `v-${r}-${c}`, `v-${r}-${c + 1}`];
}

export type BoardAnalysis = {
  // 立即得盒的边：落子即补全某个三边盒
  captureEdges: string[];
  // 安全边：落子后不会产生任何三边盒（对手无法立即得盒）
  safeEdges: string[];
  // 危险边：落子后对手将立即得盒
  riskyEdges: string[];
};

export function analyzeBoard(room: RoomState, candidates: string[]): BoardAnalysis {
  const claimed = new Set(Object.keys(room.claimedEdges));
  const captureEdges = new Set<string>();

  for (let r = 0; r < room.boardRows; r += 1) {
    for (let c = 0; c < room.boardCols; c += 1) {
      const edges = boxEdges(r, c);
      const missing = edges.filter((e) => !claimed.has(e));
      if (missing.length === 1) {
        captureEdges.add(missing[0]);
      }
    }
  }

  const safeEdges: string[] = [];
  const riskyEdges: string[] = [];
  for (const edge of candidates) {
    if (captureEdges.has(edge)) {
      continue;
    }

    const [o, rs, cs] = edge.split('-');
    const rr = Number(rs);
    const cc = Number(cs);
    const neighbours: Array<[number, number]> =
      o === 'h'
        ? [...(rr > 0 ? [[rr - 1, cc] as [number, number]] : []), ...(rr < room.boardRows ? [[rr, cc] as [number, number]] : [])]
        : [...(cc > 0 ? [[rr, cc - 1] as [number, number]] : []), ...(cc < room.boardCols ? [[rr, cc] as [number, number]] : [])];

    const givesCapture = neighbours.some(([br, bc]) => {
      const edges = boxEdges(br, bc);
      const present = edges.filter((e) => e === edge || claimed.has(e)).length;
      return present === 3;
    });

    if (givesCapture) {
      riskyEdges.push(edge);
    } else {
      safeEdges.push(edge);
    }
  }

  return { captureEdges: [...captureEdges].filter((e) => candidates.includes(e)), safeEdges, riskyEdges };
}

// 规则（与规则弹窗同源）+ Berlekamp 高阶策略 + 已计算的战术事实 → 提示词
export function buildPrompt(room: RoomState, me: PlayerSymbol, valid: string[]): string {
  const rulesText = GAME_RULES.map(
    (section) => `【${section.title}】\n${section.items.map((item) => `- ${item}`).join('\n')}`,
  ).join('\n');
  const strategyText = AI_STRATEGY.map(
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

  const analysis = analyzeBoard(room, valid);
  const list = (arr: string[], empty: string) => (arr.length ? arr.join(', ') : empty);
  const captureText = analysis.captureEdges.length
    ? analysis.captureEdges.join(', ')
    : '无';

  return [
    `你是点格棋（Dots and Boxes）顶尖高手，棋盘 ${room.boardRows}x${room.boardCols}，你执 ${me} 方。请依据以下规则、策略与精确的战术分析选出最佳一步。`,
    '',
    '== 游戏规则 ==',
    rulesText,
    '',
    '== 高阶策略（Berlekamp《The Dots-and-Boxes Game》）==',
    strategyText,
    '',
    '== 当前局面 ==',
    `第 ${room.roundNumber} 局，状态：${room.status}，轮到 ${room.currentTurn} 方（你）。`,
    `比分：A ${room.scores.A} : B ${room.scores.B}（你是 ${me} 方，你的得盒数为 ${room.scores[me]}）。`,
    `已占边：${claimedText}`,
    `已归属盒子：${boxesText}`,
    '',
    '== 战术分析（系统已为你精确计算）==',
    `可落的边（全部）：${valid.join(', ')}`,
    `立即得盒的边（落子即得 1 分并可继续行动）：${captureText}`,
    `安全边（落子后不会产生任何三边盒，对手无法立即得盒）：${list(analysis.safeEdges, '无')}`,
    `危险边（落子后对手立即得盒，仅在被迫开链时按牺牲原则选择）：${list(analysis.riskyEdges, '无')}`,
    '',
    '== 决策流程（严格按序）==',
    '1. 若"立即得盒的边"非空 → 选它。',
    '2. 否则若存在安全边 → 在安全边中选择：优先保留长链结构、避免制造半开短链、服务长链奇偶目标。',
    '3. 若只有危险边（被迫开链）→ 按让链/牺牲原则挑选：优先送出"2 盒短链"（硬心施舍）而非会形成可 double-dealing 的结构，并确保对手吃完后打开的下一条链对你有利。',
    '4. 输出限制不变。',
    '',
    '== 输出要求 ==',
    '只输出一个 JSON 对象：{"edge":"<从可落的边中选一条>"}，不要输出任何解释或其他内容。',
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
        // 纯文本时发字符串 content，最大化对 DeepSeek/小模型等严格兼容端点的适配
        messages: [{ role: 'user', content: imageDataUrl ? content : prompt }],
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
      const [orientation, rs, cs] = edge.split('-');
      ctx.strokeStyle = colors[owner];
      ctx.beginPath();
      if (orientation === 'h') {
        ctx.moveTo(x(Number(cs)), y(Number(rs)));
        ctx.lineTo(x(Number(cs) + 1), y(Number(rs)));
      } else {
        ctx.moveTo(x(Number(cs)), y(Number(rs)));
        ctx.lineTo(x(Number(cs)), y(Number(rs) + 1));
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

#!/usr/bin/env python3
"""Build evidence-backed organization, structure, and style knowledge from local PPT inventory."""
from __future__ import annotations

import collections
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
LAYOUT_ROOT = ROOT / ".tmp" / "audit-hi"


def counter_dict(counter, limit=None):
    items = counter.most_common(limit)
    return {str(key): value for key, value in items}


def clean_title(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def primary(items, fallback="未分类"):
    return items[0] if items else fallback


def scene_for(page):
    return primary(page.get("sceneTags") or page.get("scenarios"), "无场景")


def structure_for(page):
    return primary(page.get("structureTags"), page.get("pageType") or "内容")


def density_for(page):
    chars = len(str(page.get("extractedText") or ""))
    blocks = len(page.get("textBlocks") or [])
    assets = int(page.get("assetCount") or 0)
    if chars <= 60 and blocks <= 3:
        return "低密度"
    if chars >= 900 or blocks >= 15:
        return "高密度"
    if assets >= 3 and chars < 500:
        return "视觉型"
    return "中密度"


def layout_signature(page):
    chars = len(str(page.get("extractedText") or ""))
    char_bin = "short" if chars < 120 else "medium" if chars < 700 else "long"
    return "|".join([
        structure_for(page),
        density_for(page),
        str(len(page.get("textBlocks") or [])),
        str(int(page.get("assetCount") or 0)),
        str(page.get("titleSource") or "unknown"),
        char_bin,
    ])


def deck_archetype(deck, pages):
    name = deck.get("name", "")
    text = " ".join([name] + [str(page.get("title") or "") for page in pages]).lower()
    if "竞品" in text or "vs" in text:
        return "竞品对比"
    customer_solution_signals = sum(token in text for token in ("解决方案", "方案汇报", "客户案例", "合作模式", "sla", "服务承诺"))
    chapter_roles = sum(any(tag in {"客户案例", "公司介绍", "产品介绍", "商旅", "费控", "管控", "合规", "AI", "Agent", "服务"} for tag in (page.get("sceneTags") or [])) for page in pages)
    if customer_solution_signals >= 3 and (len(pages) >= 40 or chapter_roles >= 5):
        return "客户整体方案"
    if customer_solution_signals >= 2 and len(pages) >= 12:
        return "客户专项方案"
    if any(token in text for token in ("启动会", "操作手册", "阶段工作", "项目复盘", "内部汇报", "周报")):
        return "项目/内部汇报"
    if "案例" in text or any(tag == "客户案例" for page in pages for tag in page.get("sceneTags", [])):
        return "客户案例/项目方案"
    if "简介" in text or "公司介绍" in text:
        return "公司/产品介绍"
    if any(tag in {"AI", "Agent"} for page in pages for tag in page.get("sceneTags", [])):
        return "AI/Agent 方案"
    if any(tag in {"商旅", "机票", "酒店", "火车", "用车", "用餐"} for page in pages for tag in page.get("sceneTags", [])):
        return "商旅/费控方案"
    return "综合方案"


def walk(value, key=None):
    yield key, value
    if isinstance(value, dict):
        for child_key, child in value.items():
            yield from walk(child, child_key)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child, key)


def load_layout_evidence():
    layout_names = collections.Counter()
    typefaces = collections.Counter()
    font_sizes = collections.Counter()
    colors = collections.Counter()
    slide_sizes = collections.Counter()
    files = 0
    for file in LAYOUT_ROOT.glob("run-*/template-inspect/layouts/*.layout.json"):
        try:
            payload = json.loads(file.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        files += 1
        slide = payload.get("slide", {})
        frame = slide.get("frame", {})
        if frame.get("width") and frame.get("height"):
            slide_sizes[f"{round(frame['width'])}x{round(frame['height'])}"] += 1
        layout_name = slide.get("layoutName")
        if layout_name:
            layout_names[layout_name] += 1
        for key, value in walk(payload):
            if key in {"typeface", "latinTypeface", "eastAsiaTypeface"} and isinstance(value, str) and value.strip():
                typefaces[value.strip()] += 1
            elif key == "fontSize" and isinstance(value, (int, float)) and math.isfinite(value):
                font_sizes[str(round(float(value), 1))] += 1
            elif key in {"lineColor", "color", "fillColor", "backgroundColor"}:
                if isinstance(value, str) and re.fullmatch(r"#[0-9A-Fa-f]{6,8}", value):
                    colors[value.upper()] += 1
                elif isinstance(value, dict):
                    for nested in ("hex", "value", "rgb"):
                        candidate = value.get(nested)
                        if isinstance(candidate, str) and re.fullmatch(r"#[0-9A-Fa-f]{6,8}", candidate):
                            colors[candidate.upper()] += 1
    return {
        "layoutFiles": files,
        "slideSizes": counter_dict(slide_sizes),
        "layoutNames": counter_dict(layout_names, 20),
        "typefaces": counter_dict(typefaces, 20),
        "fontSizes": counter_dict(font_sizes, 30),
        "hexColors": counter_dict(colors, 30),
    }


pages = json.loads((DATA / "pages.json").read_text())
decks = json.loads((DATA / "decks.json").read_text())
by_deck = collections.defaultdict(list)
for page in pages:
    by_deck[page.get("deckId")].append(page)
for deck_pages in by_deck.values():
    deck_pages.sort(key=lambda item: int(item.get("sourcePage") or 0))

visible_pages = [page for page in pages if page.get("libraryStatus", "active") != "excluded"]
all_structures = collections.Counter(structure_for(page) for page in pages)
visible_structures = collections.Counter(structure_for(page) for page in visible_pages)
scenes = collections.Counter(tag for page in visible_pages for tag in (page.get("sceneTags") or page.get("scenarios") or []))
density = collections.Counter(density_for(page) for page in visible_pages)
signatures = collections.Counter(layout_signature(page) for page in visible_pages)

decks_out = []
archetypes = collections.Counter()
transitions = collections.Counter()
scene_transitions = collections.Counter()
opening_patterns = collections.Counter()
closing_patterns = collections.Counter()
for deck in decks:
    deck_pages = by_deck.get(deck.get("id"), [])
    archetype = deck_archetype(deck, deck_pages)
    archetypes[archetype] += 1
    sequence = [f"{structure_for(page)} / {scene_for(page)}" for page in deck_pages]
    for left, right in zip(sequence, sequence[1:]):
        transitions[f"{left} → {right}"] += 1
    scene_sequence = [scene_for(page) for page in deck_pages]
    for left, right in zip(scene_sequence, scene_sequence[1:]):
        scene_transitions[f"{left} → {right}"] += 1
    if sequence:
        opening_patterns[" → ".join(sequence[:3])] += 1
        closing_patterns[" → ".join(sequence[-3:])] += 1
    decks_out.append({
        "id": deck.get("id"),
        "name": deck.get("name"),
        "pageCount": len(deck_pages),
        "archetype": archetype,
        "sequence": [
            {
                "page": page.get("sourcePage"),
                "id": page.get("id"),
                "title": clean_title(page.get("title")),
                "structure": structure_for(page),
                "scenes": page.get("sceneTags") or page.get("scenarios") or [],
                "density": density_for(page),
                "layoutSignature": layout_signature(page),
            }
            for page in deck_pages
        ],
    })

layout_evidence = load_layout_evidence()
customer_solution_template = {
    "archetype": "客户整体方案",
    "requiredRoles": ["cover", "contents", "company_credibility", "customer_context", "case_study", "solution_overview", "module_detail", "value_roi", "control_compliance", "ai_agent", "service_sla", "closing"],
    "subsections": {
        "降本与管控": ["低价降本", "数据/管控降本", "特色方案", "合规筛查"],
        "AI 与 Agent": ["商旅 Agent", "管控 Agent", "AI 砍价与 Skills"],
        "服务与 SLA": ["客服", "SLA 与增值服务"],
    },
    "closingRequirement": "总结价值、下一步和联系方式，不能把占位页当作尾页",
}
report = {
    "version": "ppt-patterns-v1",
    "generatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
    "scope": {
        "deckCount": len(decks),
        "pageCount": len(pages),
        "visiblePageCount": len(visible_pages),
        "excludedPageCount": len(pages) - len(visible_pages),
        "note": "组织模式使用全部来源页；页面推荐相关统计优先使用资源库可见页。",
    },
    "organization": {
        "deckArchetypes": counter_dict(archetypes),
        "topOpeningPatterns": counter_dict(opening_patterns, 20),
        "topClosingPatterns": counter_dict(closing_patterns, 20),
        "topTransitions": counter_dict(transitions, 40),
        "topSceneTransitions": counter_dict(scene_transitions, 40),
        "customerSolutionTemplate": customer_solution_template,
        "decks": decks_out,
    },
    "pageStructure": {
        "allStructureTags": counter_dict(all_structures),
        "visibleStructureTags": counter_dict(visible_structures),
        "sceneTags": counter_dict(scenes, 30),
        "density": counter_dict(density),
        "layoutSignatures": counter_dict(signatures, 40),
        "titleSources": counter_dict(collections.Counter(page.get("titleSource") for page in visible_pages)),
    },
    "design": layout_evidence,
}
(DATA / "ppt-patterns.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

def lines(mapping, limit=10):
    return "\n".join(f"- {key}：{value}" for key, value in list(mapping.items())[:limit]) or "- 暂无"


doc = f"""# 公司 PPT 模式分析

生成时间：{report['generatedAt']}

## 1. 分析范围

- 来源文件：{len(decks)} 份
- 来源页面：{len(pages)} 页
- 当前资源库可见页面：{len(visible_pages)} 页
- 已隐藏页面：{len(pages) - len(visible_pages)} 页

组织模式使用全部来源页，以保留原始 PPT 的真实叙事顺序；页面复用相关统计使用当前可见页面，避免重复候选影响推荐。

## 2. 整套方案组织模式

### PPT 类型分布

{lines(counter_dict(archetypes))}

### 高频开场组合

以下是按当前页面标签推断的前三页组合，属于统计观察，不是强制模板：

{lines(counter_dict(opening_patterns, 12))}

### 高频页面转场

{lines(counter_dict(transitions, 20))}

### 高频场景转场

{lines(counter_dict(scene_transitions, 20))}

当前数据能支持 Agent 学习“哪些页面经常相邻、哪些场景常见组合”，但还不能单独证明某个客户方案必须遵循固定顺序。后续需要把客户类型、销售阶段和用户目标纳入任务上下文。

### 客户整体方案模板（由中国移动 106 页方案复盘）

客户整体方案必须形成完整的销售叙事：封面 → 目录 → 公司与平台可信度 → 客户背景/案例 → 整体产品与价值 → 核心模块 → 降本与 ROI → 管控与合规 → AI/Agent → 服务与 SLA → 总结/下一步/联系方式。

降本与管控章节需要拆成低价降本、数据/管控降本、特色方案和合规筛查；AI 章节拆成商旅 Agent、管控 Agent、AI 砍价与 Skills；服务章节拆成客服和 SLA/增值服务。目录页在长方案中重复出现，用于章节边界，不应当当作普通内容页。

当前数据里的封面标签混合了章节页，生成时只把方案第 1 页当封面，其余标题型分区页映射为章节页。第 106 页是空占位，不能作为尾页；完整方案必须补充总结、下一步或联系方式页。

## 3. 页面结构模式

### 页面结构标签

全部来源页：

{lines(counter_dict(all_structures))}

当前可见页面：

{lines(counter_dict(visible_structures))}

现有结构标签仍偏粗，绝大多数页面落在“内容”。下一步建议增加可计算的结构特征，而不是立即增加更多人工标签：标题区、正文区、数据区、表格、流程、图片、卡片数量和页面密度。

### 场景分布

{lines(counter_dict(scenes, 20))}

### 页面密度

{lines(counter_dict(density))}

### 页面识别证据

标题主要来自 PPTX XML 的标题占位符和位置/字号规则。图片型页面仍使用少量视觉覆盖标题，不能把标题识别全部交给纯文本模型。

## 4. 设计风格证据

### 版式尺寸

{lines(layout_evidence.get('slideSizes', {}))}

### 常见版式名称

{lines(layout_evidence.get('layoutNames', {}), 12)}

### 字体

{lines(layout_evidence.get('typefaces', {}), 12)}

### 字号

{lines(layout_evidence.get('fontSizes', {}), 20)}

### 颜色

{lines(layout_evidence.get('hexColors', {}), 20)}

## 5. 给 Agent 的第一版约束

1. 先判断任务类型：竞品对比、客户方案、商旅/费控方案、AI/Agent 方案或内部汇报。
2. 先生成提纲和页面角色，再选择具体页面，不能只按关键词拼页。
3. 封面、目录、章节过渡和尾页要单独处理，不与普通内容页混选。
4. 页面选择优先使用当前可见、已确认、来源可追溯的页面。
5. 页面顺序参考历史高频转场，但必须受客户目标和销售阶段约束。
6. 新页面生成必须继承已有模板的字体、字号、色彩、间距和标题层级。
7. 任何自动组合结果都进入右侧预览牌堆，由销售最终调整和确认。

## 6. 当前分析的限制

- 现有页面结构标签仍以“封面/目录/内容/尾页”为主，章节页、数据页、案例页等需要从 XML 和视觉特征进一步推断。
- 仅凭标题和文本无法可靠判断页面的论证关系，需要结合图片、表格、布局和相邻页面。
- 当前报告是可解释的统计基线，不是已经训练完成的生成模型。
- 设计数据来自已生成的布局检查文件；新增 PPT 若未经过布局检查，需要在导入时补充相同的设计元数据抽取。
"""
(ROOT / "PPT_KNOWLEDGE.md").write_text(doc)
print(json.dumps({"decks": len(decks), "pages": len(pages), "visiblePages": len(visible_pages), "layoutFiles": layout_evidence["layoutFiles"], "output": ["data/ppt-patterns.json", "PPT_KNOWLEDGE.md"]}, ensure_ascii=False))

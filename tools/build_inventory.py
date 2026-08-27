import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "source_ppts"
AUDIT_DIR = ROOT / ".tmp" / "audit-hi"
ASSET_DIR = ROOT / "assets" / "pages"
DATA_DIR = ROOT / "data"
NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
P_NS = {"p": "http://schemas.openxmlformats.org/presentationml/2006/main", **NS}

STRUCTURE_ENUM = ["封面", "目录", "内容", "尾页"]
SCENE_ENUM = [
    "公司介绍", "产品介绍", "商旅", "机票", "酒店", "火车", "用车", "用餐",
    "费控", "报销", "AI", "Agent", "管控", "合规", "降本", "SLA", "MICE",
    "发票", "支付", "客户案例", "流程", "数据", "服务"
]

# A small set of image-only slides whose visible title is part of the rendered artwork,
# so it cannot be recovered from the slide XML text boxes.
TITLE_OVERRIDES = {
    ("_蓝箭航天_商旅方案汇报_260611_v4.pptx", 5): "国内酒店：资源丰富，品类齐全，积分权益",
    ("分贝通Agent发布会_吴荣彬_260315_v2.pptx", 11): "管控Agent概览",
    ("01.竞品分析(vs易快报)_230524.pptx", 14): "日积跬步推动企业支付体验的改变",
    ("04.竞品分析(vs携程商旅)_230222.pptx", 12): "日积跬步推动企业支付体验的改变",
    ("06.分贝通竞品分析_230321.pptx", 7): "日积跬步推动企业支付体验的改变",
    ("分贝通AI新视野大会PPT-吴荣彬-260316.pptx", 1): "分贝通 Agent 发布会",
    ("分贝通Agent发布会_吴荣彬_260315_v2.pptx", 1): "分贝通 Agent 发布会",
    ("分贝通ToC Agent介绍_260717.pptx", 35): "日积跬步推动企业支付体验的改变",
    ("分贝通企业支出管理解决方案介绍-管控_报销Agent模块-260810.pptx", 71): "日积跬步推动企业支付体验的改变",
    ("分贝通简介_1.pptx", 63): "日积跬步推动企业支付体验的改变",
    ("商旅Agent产研启动会汇报_260225.pptx", 4): "日积跬步推动企业支付体验的改变",
    ("帕西尼阶段工作汇报-V2.pptx", 18): "日积跬步推动企业支付体验的改变",
    ("桑达商旅云AI项目方案_260520A_乔健更新.pptx", 11): "日积跬步推动企业支付体验的改变",
}


def infer_labels(title, text, page_no, page_count):
    searchable = f"{title} {' '.join(text[:8])}"
    structure = ["内容"]
    if page_no == 1:
        structure = ["封面"]
    elif "目录" in title:
        structure = ["目录"]
    elif page_no == page_count or any(token in title for token in ("感谢", "谢谢", "Thank", "尾页")):
        structure = ["尾页"]

    scene_rules = {
        "公司介绍": ("公司|简介|融资|奖项|独角兽|企业介绍",),
        "产品介绍": ("产品|解决方案|功能|全家桶|平台",),
        "商旅": ("商旅|出差|行程|旅行",),
        "机票": ("机票|航司|航班",),
        "酒店": ("酒店|房型|间夜|住宿|同住",),
        "火车": ("火车|高铁|动车",),
        "用车": ("用车|接送机|司机|租车|打车|网约车",),
        "用餐": ("用餐|外卖|到餐|点餐|商户|餐饮",),
        "费控": ("费控|支出|费用|消费",),
        "报销": ("报销|核销",),
        "AI": ("AI|人工智能|智能|砍价|多模态",),
        "Agent": ("Agent|智能体",),
        "管控": ("管控|规则|差标|预算",),
        "合规": ("合规|查重|筛查|风险",),
        "降本": ("降本|低价|节省|价格|贵必赔",),
        "SLA": ("SLA|客服SLA|接通率|一次性解决率",),
        "MICE": ("MICE|会务|团队|会议|定制线路",),
        "发票": ("发票|开票",),
        "支付": ("支付|付款|结算|充值|网银",),
        "客户案例": ("案例|客户|威高|蓝箭|使用情况|合作情况",),
        "流程": ("流程|步骤|链路|一体化|全流程",),
        "数据": ("数据|指标|亿元|万|%|准确度|规模",),
        "服务": ("服务|资源|保障|客服|供应链",),
    }
    title_only = {"公司介绍", "客户案例", "SLA", "MICE"}
    scenes = [label for label, patterns in scene_rules.items() if any(re.search(pattern, title if label in title_only else searchable, re.I) for pattern in patterns)]
    if not scenes:
        scenes = ["产品介绍"] if structure == ["内容"] else []
    keywords = []
    for candidate in SCENE_ENUM:
        if candidate in scenes and candidate not in keywords:
            keywords.append(candidate)
    for token in re.findall(r"[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9+/-]{1,15}", title):
        if token not in keywords and token not in {"分贝通", "介绍", "方案", "内容"}:
            keywords.append(token)
        if len(keywords) >= 5:
            break
    description = re.sub(r"\s+", " ", title).strip()[:60]
    return structure, scenes[:6], keywords[:5], description


def slide_number(name):
    return int(re.search(r"slide(\d+)\.xml$", name).group(1))


def audited_preview_map():
    mapping = {}
    for manifest in AUDIT_DIR.glob("*/template-inspect/template-manifest.json"):
        payload = json.loads(manifest.read_text())
        source = Path(payload["sourcePptx"]).resolve()
        mapping[source] = {
            item["slide"]: Path(item["previewPath"])
            for item in payload["slideArtifacts"]
        }
    return mapping


def paragraphs(slide_xml):
    root = ET.fromstring(slide_xml)
    output = []
    for paragraph in root.findall(".//a:p", NS):
        text = "".join(node.text or "" for node in paragraph.findall(".//a:t", NS))
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            output.append(text)
    return output


def text_blocks(slide_xml):
    """Keep source text plus enough layout evidence to identify a slide title."""
    root = ET.fromstring(slide_xml)
    blocks = []
    for shape in root.findall(".//p:sp", P_NS):
        values = []
        for paragraph in shape.findall(".//a:p", P_NS):
            value = "".join(node.text or "" for node in paragraph.findall(".//a:t", P_NS))
            value = re.sub(r"\s+", " ", value).strip()
            if value:
                values.append(value)
        if not values:
            continue
        placeholder = shape.find("./p:nvSpPr/p:nvPr/p:ph", P_NS)
        placeholder_type = placeholder.attrib.get("type") if placeholder is not None else None
        off = shape.find("./p:spPr/a:xfrm/a:off", P_NS)
        ext = shape.find("./p:spPr/a:xfrm/a:ext", P_NS)
        sizes = []
        for node in shape.iter():
            size = node.attrib.get("sz")
            if size and size.isdigit():
                sizes.append(int(size) / 100)
        blocks.append({
            "text": " ".join(values),
            "x": int(off.attrib.get("x", 0)) if off is not None else None,
            "y": int(off.attrib.get("y", 0)) if off is not None else None,
            "width": int(ext.attrib.get("cx", 0)) if ext is not None else None,
            "height": int(ext.attrib.get("cy", 0)) if ext is not None else None,
            "fontSize": max(sizes, default=None),
            "placeholder": placeholder_type,
        })
    return blocks


def slide_size(archive):
    try:
        root = ET.fromstring(archive.read("ppt/presentation.xml"))
        node = root.find(".//p:sldSz", P_NS)
        return (int(node.attrib["cx"]), int(node.attrib["cy"]))
    except (KeyError, TypeError, ValueError, ET.ParseError):
        return (12192000, 6858000)


def title_is_noise(text):
    value = re.sub(r"[\s·•…._-]+", "", text or "")
    return (
        not value
        or re.fullmatch(r"[0-9０-９/\\:：()（）]+", value) is not None
        or re.fullmatch(r"(?:第)?[0-9０-９]+(?:页|页面|slide|page)?", value, re.I) is not None
        or re.fullmatch(r"[①②③④⑤⑥⑦⑧⑨⑩]+", value) is not None
    )


def display_text_is_noise(text):
    """Reject page-number placeholders that should never become visible metadata."""
    value = re.sub(r"\s+", "", text or "")
    return (
        not value
        or re.fullmatch(r"[0-9０-９]+", value) is not None
        or re.fullmatch(r"(?:第)?[0-9０-９]+(?:页|页面|slide|page)", value, re.I) is not None
        or re.fullmatch(r"[Pp][0-9０-９]+", value) is not None
    )


def normalize_title_candidate(text):
    """Collapse common deck-level title artifacts before labeling."""
    value = re.sub(r"\s+", " ", text or "").strip()
    if re.match(r"^1\s+.+\s+2\s+.+\s+3\s+", value):
        return "目录"
    return value


def infer_title(blocks, fallback, canvas):
    candidates = []
    canvas_height = canvas[1] or 6858000
    for block in blocks:
        text = block["text"].strip()
        y = block["y"]
        is_title_placeholder = block.get("placeholder") in {"title", "ctrTitle"}
        max_length = 160 if is_title_placeholder else 110
        if title_is_noise(text) or len(text) > max_length or (not is_title_placeholder and y is not None and y > canvas_height * 0.72):
            continue
        if is_title_placeholder:
            candidates.append((1.30, text))
            continue
        top_score = 1 - min((y or 0) / (canvas_height * 0.55), 1)
        size_score = min((block["fontSize"] or 0) / 34, 1)
        length_score = 1 if 4 <= len(text) <= 70 else 0.45
        score = top_score * 0.60 + size_score * 0.30 + length_score * 0.10
        candidates.append((score, text))
    if candidates:
        return normalize_title_candidate(max(candidates, key=lambda item: item[0])[1])
    return fallback if not title_is_noise(fallback) else "未识别标题"


def deck_id(index):
    return f"deck-{index:02d}"


def main():
    preview_map = audited_preview_map()
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    existing_pages = {}
    existing_decks = {}
    existing_metadata = {}
    pages_path = DATA_DIR / "pages.json"
    decks_path = DATA_DIR / "decks.json"
    if pages_path.exists():
        existing_pages = {item.get("id"): item for item in json.loads(pages_path.read_text())}
    if decks_path.exists():
        existing_decks = {item.get("name"): item for item in json.loads(decks_path.read_text())}
    metadata_path = DATA_DIR / "source-metadata.json"
    if metadata_path.exists():
        existing_metadata = json.loads(metadata_path.read_text())
    used_deck_ids = {item.get("id") for item in existing_decks.values() if item.get("id")}
    next_deck_index = max((int(item[5:]) for item in used_deck_ids if re.fullmatch(r"deck-\d+", item)), default=0) + 1
    pages = []
    decks = []
    source_metadata = {}

    for pptx in sorted(SOURCE_DIR.glob("*.pptx")):
        digest = hashlib.sha256(pptx.read_bytes()).hexdigest()
        existing_deck = existing_decks.get(pptx.name)
        if existing_deck:
            deck_key = existing_deck["id"]
        else:
            while deck_id(next_deck_index) in used_deck_ids:
                next_deck_index += 1
            deck_key = deck_id(next_deck_index)
            used_deck_ids.add(deck_key)
            next_deck_index += 1
        preview_dir = ASSET_DIR / deck_key
        preview_dir.mkdir(parents=True, exist_ok=True)
        deck_pages = []
        metadata_pages = []
        with zipfile.ZipFile(pptx) as archive:
            canvas = slide_size(archive)
            slide_names = sorted(
                (name for name in archive.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", name)),
                key=slide_number,
            )
            for page_no, slide_name in enumerate(slide_names, start=1):
                slide_xml = archive.read(slide_name)
                text = paragraphs(slide_xml)
                blocks = text_blocks(slide_xml)
                title_override = TITLE_OVERRIDES.get((pptx.name, page_no))
                title = title_override or infer_title(blocks, text[0] if text else "", canvas)
                has_xml_title = any(
                    block.get("placeholder") in {"title", "ctrTitle"} and block.get("text", "").strip() == title
                    for block in blocks
                )
                title_source = (
                    "rendered-visual-override-v1" if title_override
                    else "xml-title-placeholder-v2" if has_xml_title
                    else "xml-position-font-v1"
                )
                if title == "未识别标题":
                    title = "待补充标题"
                    title_source = "fallback-empty-v1"
                page_id = f"{deck_key}-p{page_no:03d}"
                preview_source = preview_map.get(pptx.resolve(), {}).get(page_no)
                preview_path = ""
                if preview_source and preview_source.exists():
                    target = preview_dir / f"page-{page_no:03d}.png"
                    # The audit render is the source of truth; overwrite stale 1x previews.
                    shutil.copy2(preview_source, target)
                    preview_path = f"assets/pages/{deck_key}/page-{page_no:03d}.png"
                structure_tags, scene_tags, keywords, description = infer_labels(title, text, page_no, len(slide_names))
                if title == "待补充标题":
                    description = ""
                page = {
                    "id": page_id,
                    "sourceType": "imported",
                    "deckId": deck_key,
                    "sourceFile": pptx.name,
                    "sourcePage": page_no,
                    "preview": preview_path,
                    "title": title,
                    "titleSource": title_source,
                    "extractedText": "\n".join(text)[:12000],
                    "pageType": structure_tags[0],
                    "structureTags": structure_tags,
                    "sceneTags": scene_tags,
                    "tags": keywords,
                    "scenarios": scene_tags,
                    "description": description,
                    "annotationSource": "rendered-visual-override-v1" if title_override else "title-rules-v1",
                    "reviewStatus": "prelabeled",
                    "libraryStatus": "active",
                    "assetCount": len(ET.fromstring(archive.read(slide_name)).findall(".//a:blip", NS)),
                }
                previous = existing_pages.get(page_id)
                if previous:
                    for field in ("structureTags", "sceneTags", "tags", "scenarios", "pageType", "annotationSource", "reviewStatus", "libraryStatus"):
                        if field in previous:
                            page[field] = previous[field]
                    if previous.get("aiLabeling"):
                        page["aiLabeling"] = previous["aiLabeling"]
                    if title_override:
                        page["annotationSource"] = "rendered-visual-override-v1"
                    # Older indexes stored the source page number as the description.
                    # Keep real manual text, but regenerate these placeholders from the title.
                    previous_description = previous.get("description")
                    if previous_description and not display_text_is_noise(previous_description):
                        page["description"] = previous_description
                pages.append(page)
                deck_pages.append(page_id)
                metadata_pages.append({
                    "page": page_no,
                    "pageId": page_id,
                    "title": title,
                    "titleSource": title_source,
                    "allText": "\n".join(text),
                    "textBlocks": blocks,
                    "aiLabeling": {"status": "pending", "model": None, "result": None},
                })
                previous_metadata = existing_metadata.get(deck_key, {}).get("pages", [])
                previous_by_page = {item.get("page"): item for item in previous_metadata}
                if page_no in previous_by_page and previous_by_page[page_no].get("aiLabeling"):
                    metadata_pages[-1]["aiLabeling"] = previous_by_page[page_no]["aiLabeling"]
        source_metadata[deck_key] = {
            "sourceFile": pptx.name,
            "sha256": digest,
            "pageCount": len(deck_pages),
            "pages": metadata_pages,
        }
        decks.append({
            "id": deck_key,
            "name": pptx.name,
            "pageCount": len(deck_pages),
            "sha256": digest,
            "templateFamily": "fenbeitong-brand-v1",
            "pageIds": deck_pages,
        })

    (DATA_DIR / "pages.json").write_text(json.dumps(pages, ensure_ascii=False, indent=2) + "\n")
    (DATA_DIR / "decks.json").write_text(json.dumps(decks, ensure_ascii=False, indent=2) + "\n")
    (DATA_DIR / "source-metadata.json").write_text(json.dumps(source_metadata, ensure_ascii=False, indent=2) + "\n")
    (DATA_DIR / "tag-enums.json").write_text(json.dumps({"structure": STRUCTURE_ENUM, "scene": SCENE_ENUM}, ensure_ascii=False, indent=2) + "\n")
    js = "window.REAL_PAGES = " + json.dumps(pages, ensure_ascii=False, separators=(",", ":")) + ";\n"
    (DATA_DIR / "pages.js").write_text(js)
    print(f"indexed {len(decks)} decks / {len(pages)} pages")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Extract slide text and layout metadata from a PPTX without changing the deck."""
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}


def slide_number(name):
    return int(re.search(r"slide(\d+)\.xml$", name).group(1))


def clean(value):
    return re.sub(r"\s+", " ", value or "").strip()


def paragraphs(root):
    values = []
    for paragraph in root.findall(".//a:p", NS):
        text = clean("".join(node.text or "" for node in paragraph.findall(".//a:t", NS)))
        if text:
            values.append(text)
    return values


def text_blocks(root):
    blocks = []
    for shape in root.findall(".//p:sp", NS):
        values = []
        for paragraph in shape.findall(".//a:p", NS):
            text = clean("".join(node.text or "" for node in paragraph.findall(".//a:t", NS)))
            if text:
                values.append(text)
        if not values:
            continue
        placeholder = shape.find("./p:nvSpPr/p:nvPr/p:ph", NS)
        off = shape.find("./p:spPr/a:xfrm/a:off", NS)
        ext = shape.find("./p:spPr/a:xfrm/a:ext", NS)
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
            "placeholder": placeholder.attrib.get("type") if placeholder is not None else None,
        })
    return blocks


def noise_title(value):
    text = re.sub(r"[\s·•…._-]+", "", value or "")
    return (not text or re.fullmatch(r"[0-9０-９/\\:：()（）]+", text) or
            re.fullmatch(r"(?:第)?[0-9０-９]+(?:页|页面|slide|page)?", text, re.I))


def infer_title(blocks, fallback, canvas_height):
    candidates = []
    for block in blocks:
        text = block["text"]
        placeholder = block.get("placeholder") in {"title", "ctrTitle"}
        if noise_title(text) or len(text) > (160 if placeholder else 110):
            continue
        if block.get("y") is not None and block["y"] > canvas_height * 0.72 and not placeholder:
            continue
        if placeholder:
            candidates.append((1.5, text))
            continue
        top = 1 - min((block.get("y") or 0) / max(canvas_height * 0.55, 1), 1)
        size = min((block.get("fontSize") or 0) / 34, 1)
        length = 1 if 4 <= len(text) <= 70 else 0.45
        candidates.append((top * 0.6 + size * 0.3 + length * 0.1, text))
    title = max(candidates, key=lambda item: item[0])[1] if candidates else fallback
    if re.match(r"^1\s+.+\s+2\s+.+\s+3\s+", title or ""):
        title = "目录"
    return title if title and not noise_title(title) else "待补充标题"


def infer_labels(title, text, page_no, page_count):
    searchable = f"{title} {text}"
    structure = ["封面"] if page_no == 1 else ["尾页"] if page_no == page_count else ["目录"] if "目录" in title else ["内容"]
    rules = {
        "公司介绍": r"公司|简介|融资|奖项|企业介绍", "产品介绍": r"产品|解决方案|功能|平台",
        "商旅": r"商旅|出差|行程|旅行", "机票": r"机票|航司|航班", "酒店": r"酒店|房型|间夜|住宿",
        "火车": r"火车|高铁|动车", "用车": r"用车|接送机|司机|租车|打车", "用餐": r"用餐|外卖|餐饮|点餐",
        "费控": r"费控|支出|费用|消费", "报销": r"报销|核销", "AI": r"AI|人工智能|智能|多模态",
        "Agent": r"Agent|智能体", "管控": r"管控|规则|差标|预算", "合规": r"合规|查重|风险",
        "降本": r"降本|低价|节省|价格", "SLA": r"SLA|接通率|解决率", "MICE": r"MICE|会务|会议|团建",
        "发票": r"发票|开票", "支付": r"支付|付款|结算|充值", "客户案例": r"案例|客户|使用情况",
        "流程": r"流程|步骤|链路|全流程", "数据": r"数据|指标|亿元|万|%|准确度", "服务": r"服务|资源|保障|客服",
    }
    scenes = [label for label, pattern in rules.items() if re.search(pattern, searchable, re.I)]
    keywords = scenes[:3]
    for token in re.findall(r"[\u4e00-\u9fff]{2,8}|[A-Za-z][A-Za-z0-9+/-]{1,15}", title or ""):
        if token not in keywords and token not in {"分贝通", "介绍", "方案", "内容"}:
            keywords.append(token)
        if len(keywords) >= 5:
            break
    description = f"{title}。" if title and title != "待补充标题" and len(text) <= len(title) + 4 else ("这是封面页。" if structure == ["封面"] else "")
    return structure, scenes[:8], keywords[:5], description


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: extract_pptx.py <file.pptx>")
    source = Path(sys.argv[1]).resolve()
    with zipfile.ZipFile(source) as archive:
        try:
            presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
            size = presentation.find(".//p:sldSz", NS)
            canvas_height = int(size.attrib.get("cy", 6858000)) if size is not None else 6858000
        except Exception:
            canvas_height = 6858000
        slide_names = sorted((name for name in archive.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", name)), key=slide_number)
        pages = []
        for page_no, name in enumerate(slide_names, 1):
            root = ET.fromstring(archive.read(name))
            text = paragraphs(root)
            blocks = text_blocks(root)
            title = infer_title(blocks, text[0] if text else "", canvas_height)
            structure, scenes, keywords, description = infer_labels(title, " ".join(text), page_no, len(slide_names))
            pages.append({
                "page": page_no,
                "title": title,
                "titleSource": "xml-title-placeholder-v1" if any(b.get("placeholder") in {"title", "ctrTitle"} and b["text"] == title for b in blocks) else "xml-position-font-v1",
                "allText": "\n".join(text)[:12000],
                "textBlocks": blocks,
                "structureTags": structure,
                "sceneTags": scenes,
                "keywords": keywords,
                "description": description,
                "assetCount": len(root.findall(".//a:blip", NS)),
            })
    print(json.dumps({"sourceFile": source.name, "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "pageCount": len(pages), "pages": pages}, ensure_ascii=False))


if __name__ == "__main__":
    main()

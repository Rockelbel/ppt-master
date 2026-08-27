export function validateReferencePageContent(content, { referencePage, referenceLines = [], message = "" }) {
  const originalTitle = String(referencePage?.title || "").replace(/\s+/g, " ").trim();
  const generatedTitle = String(content?.title || "").replace(/\s+/g, " ").trim();
  const body = Array.isArray(content?.body) ? content.body.map(item => String(item || "").trim()).filter(Boolean) : [];
  const request = String(message || "");
  if (!generatedTitle || !body.length) throw new Error("模型返回的页面内容不完整，未生成新页面");
  if (/(标题).{0,20}(缩短|简短|短一点)/u.test(request) && (generatedTitle === originalTitle || generatedTitle.length >= originalTitle.length)) {
    throw new Error("模型未按要求缩短页面标题，未生成新页面");
  }
  const sourceBody = referenceLines.slice(1);
  if (body.length <= 3 && body.every(item => sourceBody.includes(item))) {
    throw new Error("模型正文仅返回原页面栏目名，未生成有效改写内容");
  }
  if (/(正文).{0,20}(扩充|展开|详细|丰富)/u.test(request) && (body.length < 2 || body.join("").length < 60)) {
    throw new Error("模型未按要求扩充页面正文，未生成新页面");
  }
}

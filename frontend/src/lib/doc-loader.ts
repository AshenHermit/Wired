export async function loadDoc(docName: string): Promise<string> {
  const response = await fetch(`/docs/${docName}.md`);
  if (!response.ok) {
    throw new Error(`Failed to load documentation: ${docName}`);
  }
  return response.text();
}

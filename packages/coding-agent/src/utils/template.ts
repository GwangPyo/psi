export function formatTemplate(template: string, args: Record<string, string>): string {
	let result = template;
	for (const [key, value] of Object.entries(args)) {
		result = result.replaceAll(`{{${key}}}`, value);
	}
	return result;
}

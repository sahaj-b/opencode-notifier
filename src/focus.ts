import { spawn } from "child_process";
import { existsSync } from "fs";

let sessionTitle: string | null = "";

export function setSessionTitle(title: string | null) {
	sessionTitle = title;
}

export async function isOpencodeFocused(
	scriptPath: string | null,
	termInitialTitle: string | null,
): Promise<boolean> {
	if (!scriptPath) {
		return false;
	}

	if (!existsSync(scriptPath)) {
		return false;
	}

	return new Promise((resolve) => {
		const child = spawn(
			scriptPath,
			termInitialTitle
				? [sessionTitle ?? "", termInitialTitle]
				: [sessionTitle ?? ""],
			{
				stdio: ["ignore", "ignore", "ignore"],
			},
		);

		child.on("exit", async (code) => {
			const isFocused = code === 0;
			resolve(isFocused);
		});

		child.on("error", async (_) => {
			resolve(false);
		});
	});
}

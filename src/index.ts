import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { basename } from "path";
import { runCommand } from "./command";
import type { EventType, NotifierConfig } from "./config";
import {
	getMessage,
	getSoundPath,
	isEventNotificationEnabled,
	isEventSoundEnabled,
	loadConfig,
} from "./config";
import { isOpencodeFocused } from "./focus";
import { sendNotification } from "./notify";
import { playSound } from "./sound";

function getNotificationTitle(
	config: NotifierConfig,
	projectName: string | null,
): string {
	if (config.showProjectName && projectName) {
		return `OpenCode (${projectName})`;
	}
	return "OpenCode";
}

async function handleEvent(
	config: NotifierConfig,
	eventType: EventType,
	projectName: string | null,
	elapsedSeconds?: number | null,
): Promise<void> {
	const isFocused = config.suppressWhenFocused
		? await isOpencodeFocused(config.focusDetectionScript)
		: false;

	const promises: Promise<void>[] = [];

	const message = getMessage(config, eventType);

	if (!isFocused && isEventNotificationEnabled(config, eventType)) {
		const title = getNotificationTitle(config, projectName);
		promises.push(sendNotification(title, message, config.timeout));
	}

	if (!isFocused && isEventSoundEnabled(config, eventType)) {
		const customSoundPath = getSoundPath(config, eventType);
		promises.push(playSound(eventType, customSoundPath));
	}

	const minDuration = config.command?.minDuration;
	const shouldSkipCommand =
		typeof minDuration === "number" &&
		Number.isFinite(minDuration) &&
		minDuration > 0 &&
		typeof elapsedSeconds === "number" &&
		Number.isFinite(elapsedSeconds) &&
		elapsedSeconds < minDuration;

	if (!shouldSkipCommand) {
		runCommand(config, eventType, message);
	}

	await Promise.allSettled(promises);
}

function getSessionIDFromEvent(event: unknown): string | null {
	const sessionID = (event as any)?.properties?.sessionID;
	if (typeof sessionID === "string" && sessionID.length > 0) {
		return sessionID;
	}
	return null;
}

async function getElapsedSinceLastPrompt(
	client: PluginInput["client"],
	sessionID: string,
): Promise<number | null> {
	try {
		const response = await client.session.messages({ path: { id: sessionID } });
		const messages = response.data ?? [];

		let lastUserMessageTime: number | null = null;
		for (const msg of messages) {
			const info = msg.info;
			if (info.role === "user" && typeof info.time?.created === "number") {
				if (
					lastUserMessageTime === null ||
					info.time.created > lastUserMessageTime
				) {
					lastUserMessageTime = info.time.created;
				}
			}
		}

		if (lastUserMessageTime !== null) {
			return (Date.now() - lastUserMessageTime) / 1000;
		}
	} catch {}

	return null;
}

async function isChildSession(
	client: PluginInput["client"],
	sessionID: string,
): Promise<boolean> {
	try {
		const response = await client.session.get({ path: { id: sessionID } });
		const parentID = response.data?.parentID;
		return !!parentID;
	} catch {
		return false;
	}
}

async function handleEventWithElapsedTime(
	client: PluginInput["client"],
	config: NotifierConfig,
	eventType: EventType,
	projectName: string | null,
	event: unknown,
): Promise<void> {
	const minDuration = config.command?.minDuration;
	const shouldLookupElapsed =
		!!config.command?.enabled &&
		typeof config.command?.path === "string" &&
		config.command.path.length > 0 &&
		typeof minDuration === "number" &&
		Number.isFinite(minDuration) &&
		minDuration > 0;

	let elapsedSeconds: number | null = null;
	if (shouldLookupElapsed) {
		const sessionID = getSessionIDFromEvent(event);
		if (sessionID) {
			elapsedSeconds = await getElapsedSinceLastPrompt(client, sessionID);
		}
	}

	await handleEvent(config, eventType, projectName, elapsedSeconds);
}

export const NotifierPlugin: Plugin = async ({ client, directory }) => {
	const config = loadConfig();
	const projectName = directory ? basename(directory) : null;

	return {
		event: async ({ event }) => {
			if (event.type === "permission.updated") {
				await handleEventWithElapsedTime(
					client,
					config,
					"permission",
					projectName,
					event,
				);
			}

			if ((event as any).type === "permission.asked") {
				await handleEventWithElapsedTime(
					client,
					config,
					"permission",
					projectName,
					event,
				);
			}

			if (event.type === "session.idle") {
				const sessionID = getSessionIDFromEvent(event);
				if (sessionID) {
					const isChild = await isChildSession(client, sessionID);
					if (!isChild) {
						await handleEventWithElapsedTime(
							client,
							config,
							"complete",
							projectName,
							event,
						);
					} else {
						await handleEventWithElapsedTime(
							client,
							config,
							"subagent_complete",
							projectName,
							event,
						);
					}
				} else {
					await handleEventWithElapsedTime(
						client,
						config,
						"complete",
						projectName,
						event,
					);
				}
			}

			if (event.type === "session.error") {
				await handleEventWithElapsedTime(
					client,
					config,
					"error",
					projectName,
					event,
				);
			}
		},
		"permission.ask": async () => {
			await handleEvent(config, "permission", projectName, null);
		},
		"tool.execute.before": async (input) => {
			if (input.tool === "question") {
				await handleEvent(config, "question", projectName, null);
			}
		},
	};
};

export default NotifierPlugin;

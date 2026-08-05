/**
 * Verb lists, easter eggs, stall tiers, and fun facts.
 *
 * The verb is picked once per phase entry and held until the next phase
 * entry. Easter eggs (git / model / time) only seed the `requesting` phase.
 */

export type VerbSource = "generic" | "thinking" | "responding" | "egg";

export interface VerbPick {
	verb: string;
	source: VerbSource;
}

/** Requesting-phase pool: playful, "about to work" verbs. */
export const REQUESTING_VERBS: string[] = [
	"Reticulating", "Recombobulating", "Percolating", "Synthesizing",
	"Orchestrating", "Crystallizing", "Marinating", "Meandering",
	"Cogitating", "Concocting", "Crunching", "Deciphering",
	"Manifesting", "Metamorphosing", "Nebulizing", "Perambulating",
	"Photosynthesizing", "Pontificating", "Propagating", "Puttering",
	"Brewing", "Burrowing", "Befuddling", "Bloviating",
	"Boondoggling", "Canoodling", "Cerebrating", "Coalescing",
	"Fermenting", "Gallivanting", "Gobbledygooking", "Juggling",
	"Lollygagging", "Moonwalking", "Moseying", "Noodling",
	"Obfuscating", "Palavering", "Prestidigitating", "Puzzling",
	"Quantumizing", "Razzmatazzing", "Rejiggering", "Schlepping",
	"Skedaddling", "Tinkering", "Traipsing", "Transmogrifying",
	"Whimsifying", "Whirlpooling",
];

/** Thinking-phase pool. */
export const THINKING_VERBS: string[] = [
	"Pondering", "Ruminating", "Deliberating", "Contemplating",
	"Musing", "Cerebrating", "Reflecting", "Weighing options",
	"Turning it over", "Digesting", "Introspecting", "Reasoning",
	"Meditating", "Brooding", "Wondering",
];

/** Responding-phase pool. */
export const RESPONDING_VERBS: string[] = [
	"Polishing the answer", "Formatting", "Dotting the i's",
	"Gilding the lily", "Buffing the prose", "Filing the edges",
	"Making it pretty", "Wrapping up", "Finalizing",
	"Smoothing things over",
];

/** Model easter eggs, matched by substring on the current model id. */
const MODEL_EGGS: Array<[string[], string[]]> = [
	[["longcat"], ["Herding the longcat"]],
	[["grok"], ["Grokking"]],
	[["kimi", "moonshot"], ["Moonwalking", "Shooting for the moon"]],
	[["glm", "z-ai"], ["Glowing"]],
	[["phi"], ["Phi-losophizing"]],
	[["llama", "meta"], ["Llamamenting", "Herding llamas"]],
	[["qwen"], ["Qwen-dering"]],
	[["gemini", "gemma"], ["Twin-thinking", "Geminating"]],
	[["mistral"], ["Riding the mistral"]],
	[["deepseek"], ["Seeking deep", "Diving deep"]],
	[["claude", "anthropic"], ["Claudicating"]],
	[["gpt", "chatgpt", "o1", "o3", "o4", "openai"], ["GPT-ing", "Tokenizing"]],
	[["perplexity"], ["Being perplexed"]],
	[["cohere"], ["Cohering"]],
	[["minimax"], ["Minimaxing"]],
	[["nvidia"], ["CUDA-ing"]],
	[["bytedance", "seed"], ["Seeding"]],
	[["nousresearch", "hermes"], ["Delivering thoughts"]],
	[["hunyuan", "tencent"], ["Harmonizing"]],
	[["granite"], ["Carving granite"]],
];

export function modelEggFor(modelId: string): string | null {
	if (!modelId) return null;
	const id = modelId.toLowerCase();
	for (const [needles, verbs] of MODEL_EGGS) {
		if (needles.some((needle) => id.includes(needle))) {
			return verbs[Math.floor(Math.random() * verbs.length)];
		}
	}
	return null;
}

/** Time-of-day / day-of-week easter eggs. */
export function timeEggFor(now: Date): string | null {
	const h = now.getHours();
	const day = now.getDay();
	if (day === 5 && h >= 18) return "Anticipating the weekend";
	if (day === 1 && h < 12) return "Surviving the Monday";
	if (h >= 23 || h < 5) return "Summoning the night shift";
	if (h < 12) return "Warming up the coffee machine";
	if (h < 18) return "Powering through the afternoon";
	return "Winding down toward dinner";
}

/** Stall tier words: worried → desperate → existential, by elapsed stall time. */
export const STALL_TIERS: string[][] = [
	[
		"Checking the connection", "Poking the model with a stick",
		"Wondering if it's stuck", "Waiting for a sign",
		"Knocking on the API door", "Listening for tokens",
	],
	[
		"Asking nicely to hurry up", "Tapping the screen",
		"Counting to ten very slowly", "Clearing my throat loudly",
		"Jiggling the cable",
	],
	[
		"Having an existential crisis", "Reconsidering life choices",
		"Hunting for the token fairy", "Drafting an apology letter",
		"Questioning this career path", "Staring into the void",
	],
];

/** Fun facts shown in the suffix after 60s of thinking. */
export const FUN_FACTS: string[] = [
	"the word 'robot' comes from a Czech play written in 1920",
	"the QWERTY layout was originally designed to slow typists down",
	"there are more possible chess games than atoms in the universe",
	"HTTP 418 is a real status code: 'I'm a teapot'",
	"the first programmable computer weighed about 30 tons",
	"a human brain has roughly as many neurons as there are stars in the galaxy",
	"the first computer program was written in the 1840s",
	"honey never spoils — jars thousands of years old are still edible",
	"octopuses have three hearts and blue blood",
	"JavaScript was created in ten days",
	"the hottest temperature ever recorded was 56.7°C, back in 1913",
	"a group of flamingos is called a flamboyance",
];

/** Random pick from a list, avoiding an immediate repeat. */
export function pickVerb(list: string[], last: { current: number }): string {
	if (list.length === 0) return "Working";
	if (list.length === 1) return list[0];
	let i = Math.floor(Math.random() * list.length);
	if (i === last.current) i = (i + 1) % list.length;
	last.current = i;
	return list[i];
}

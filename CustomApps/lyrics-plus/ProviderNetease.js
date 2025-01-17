/**
 * @typedef {{
 *   result: {
 *     songs: {
 *       name: string,
 *       id: number,
 *		 dt: number,  // duration in ms
 *       al: {        // album
 * 			name: string,
 *       },
 *     }[],
 *   },
 * }} SearchResponse
 *
 * @typedef {{
 * 	title: string,
 * 	artist: string,
 * 	album: string,
 * 	duration: number,
 * }} Info
 */

const ProviderNetease = (function () {
	/**
	 * Search with PyNCM api.
	 *
	 * @param {Info} info
	 * @throw "Cannot find track"
	 */
	async function search(info) {
		const searchURL = `https://pyncmd.apis.imouto.in/api/pyncm?module=cloudsearch&method=GetSearchResult&keyword=`;

		const cleanTitle = Utils.removeExtraInfo(Utils.removeSongFeat(Utils.normalize(info.title)));
		const finalURL = searchURL + encodeURIComponent(`${cleanTitle} ${info.artist}`);

		/** @type {SearchResponse} */
		const searchResults = await Spicetify.CosmosAsync.get(finalURL);
		const items = searchResults.result.songs;

		// Find the best match.
		for (const song of items) {
			const expectedDuration = info.duration;
			const actualDuration = song.dt;

			// normalized expected album name
			const neAlbumName = Utils.normalize(info.album);
			const expectedAlbumName = Utils.containsHanCharacter(neAlbumName) ? await Utils.toSimplifiedChinese(neAlbumName) : neAlbumName;
			const actualAlbumName = Utils.normalize(song.al.name); // usually in Simplified Chinese

			if (actualAlbumName == expectedAlbumName || Math.abs(expectedDuration - actualDuration) < 1000) {
				return song;
			}
		}

		throw "Cannot find track";
	}

	/**
	 * @param {Info} info
	 *
	 * @returns {{
	 * 	lrc: {
	 * 		lyric: string,
	 *      klyric: undefined, // unimplemented
	 * 	},
	 * }}
	 */
	async function findLyrics(info) {
		const lyricURL = `https://pyncmd.apis.imouto.in/api/pyncm?module=track&method=GetTrackLyrics&song_id=`;

		const searchResponse = await search(info);
		const songID = searchResponse.id;

		return CosmosAsync.get(lyricURL + songID);
	}

	const creditInfo = [
		"\\s?作?\\s*词|\\s?作?\\s*曲|\\s?编\\s*曲?|\\s?监\\s*制?",
		".*编写|.*和音|.*和声|.*合声|.*提琴|.*录|.*工程|.*工作室|.*设计|.*剪辑|.*制作|.*发行|.*出品|.*后期|.*混音|.*缩混",
		"原唱|翻唱|题字|文案|海报|古筝|二胡|钢琴|吉他|贝斯|笛子|鼓|弦乐",
		"lrc|publish|vocal|guitar|program|produce|write|mix"
	];
	const creditInfoRegExp = new RegExp(`^(${creditInfo.join("|")}).*(:|：)`, "i");

	function containCredits(text) {
		return creditInfoRegExp.test(text);
	}

	function parseTimestamp(line) {
		// ["[ar:Beyond]"]
		// ["[03:10]"]
		// ["[03:10]", "lyrics"]
		// ["lyrics"]
		// ["[03:10]", "[03:10]", "lyrics"]
		// ["[1235,300]", "lyrics"]
		const matchResult = line.match(/(\[.*?\])|([^\[\]]+)/g);
		if (!matchResult?.length || matchResult.length === 1) {
			return { text: line };
		}

		const textIndex = matchResult.findIndex(slice => !slice.endsWith("]"));
		let text = "";

		if (textIndex > -1) {
			text = matchResult.splice(textIndex, 1)[0];
			text = Utils.capitalize(Utils.normalize(text, false));
		}

		const time = matchResult[0].replace("[", "").replace("]", "");

		return { time, text };
	}

	function breakdownLine(text) {
		// (0,508)Don't(0,1) (0,151)want(0,1) (0,162)to(0,1) (0,100)be(0,1) (0,157)an(0,1)
		const components = text.split(/\(\d+,(\d+)\)/g);
		// ["", "508", "Don't", "1", " ", "151", "want" , "1" ...]
		const result = [];
		for (let i = 1; i < components.length; i += 2) {
			if (components[i + 1] === " ") continue;
			result.push({
				word: components[i + 1] + " ",
				time: parseInt(components[i])
			});
		}
		return result;
	}

	function getKaraoke(list) {
		const lyricStr = list?.klyric?.lyric;

		if (!lyricStr) {
			return null;
		}

		const lines = lyricStr.split(/\r?\n/).map(line => line.trim());
		const karaoke = lines
			.map(line => {
				const { time, text } = parseTimestamp(line);
				if (!time || !text) return null;

				const [key, value] = time.split(",") || [];
				const [start, durr] = [parseFloat(key), parseFloat(value)];

				if (!isNaN(start) && !isNaN(durr) && !containCredits(text)) {
					return {
						startTime: start,
						// endTime: start + durr,
						text: breakdownLine(text)
					};
				}
				return null;
			})
			.filter(a => a);

		if (!karaoke.length) {
			return null;
		}

		return karaoke;
	}

	function getSynced(list) {
		const lyricStr = list?.lrc?.lyric;
		let noLyrics = false;

		if (!lyricStr) {
			return null;
		}

		const lines = lyricStr.split(/\r?\n/).map(line => line.trim());
		const lyrics = lines
			.map(line => {
				const { time, text } = parseTimestamp(line);
				if (text === "纯音乐, 请欣赏") noLyrics = true;
				if (!time || !text) return null;

				const [key, value] = time.split(":") || [];
				const [min, sec] = [parseFloat(key), parseFloat(value)];
				if (!isNaN(min) && !isNaN(sec) && !containCredits(text)) {
					return {
						startTime: (min * 60 + sec) * 1000,
						text: text || ""
					};
				}
				return null;
			})
			.filter(a => a);

		if (!lyrics.length || noLyrics) {
			return null;
		}
		return lyrics;
	}

	function getTranslation(list) {
		const lyricStr = list?.tlyric?.lyric;

		if (!lyricStr) {
			return null;
		}

		const lines = lyricStr.split(/\r?\n/).map(line => line.trim());
		const translation = lines
			.map(line => {
				const { time, text } = parseTimestamp(line);
				if (!time || !text) return null;

				const [key, value] = time.split(":") || [];
				const [min, sec] = [parseFloat(key), parseFloat(value)];
				if (!isNaN(min) && !isNaN(sec) && !containCredits(text)) {
					return {
						startTime: (min * 60 + sec) * 1000,
						text: text || ""
					};
				}
				return null;
			})
			.filter(a => a);

		if (!translation.length) {
			return null;
		}
		return translation;
	}

	function getUnsynced(list) {
		const lyricStr = list?.lrc?.lyric;
		let noLyrics = false;

		if (!lyricStr) {
			return null;
		}

		const lines = lyricStr.split(/\r?\n/).map(line => line.trim());
		const lyrics = lines
			.map(line => {
				const parsed = parseTimestamp(line);
				if (parsed.text === "纯音乐, 请欣赏") noLyrics = true;
				if (!parsed.text || containCredits(parsed.text)) return null;
				return parsed;
			})
			.filter(a => a);

		if (!lyrics.length || noLyrics) {
			return null;
		}
		return lyrics;
	}

	return { findLyrics, getKaraoke, getSynced, getUnsynced, getTranslation };
})();

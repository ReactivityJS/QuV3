/**
 * EMOJI SHORTCODES — one GitHub/Slack-style name per glyph in `emoji.js`'s
 * `EMOJI_EXTENDED` (a pure name→glyph lookup has no Unicode CLDR data
 * dependency in this repo, so these are hand-assigned, not generated).
 * The ONLY consumer is `emoji-autocomplete.js`'s `:`-trigger search - kept
 * in its own file so a future second consumer (e.g. a `:shortcode:` ->
 * emoji render pass over posted message bodies, mirroring Slack/Discord)
 * doesn't have to import the autocomplete engine just for this table.
 */
import { EMOJI_EXTENDED } from './emoji.js';

/** @type {Record<string, string>} emoji glyph -> shortcode name (no colons) */
export const EMOJI_SHORTCODES = Object.freeze({
  '😀': 'grinning', '😃': 'smiley', '😄': 'smile', '😁': 'grin', '😆': 'laughing', '😅': 'sweat_smile', '🤣': 'rofl', '😂': 'joy',
  '🙂': 'slightly_smiling_face', '🙃': 'upside_down_face', '😉': 'wink', '😊': 'blush', '😇': 'innocent', '🥰': 'smiling_face_with_hearts', '😍': 'heart_eyes', '🤩': 'star_struck',
  '😘': 'kissing_heart', '😗': 'kissing', '😚': 'kissing_closed_eyes', '😙': 'kissing_smiling_eyes', '😋': 'yum', '😛': 'stuck_out_tongue', '😜': 'stuck_out_tongue_winking_eye', '🤪': 'zany_face',
  '😝': 'stuck_out_tongue_closed_eyes', '🤑': 'money_mouth_face', '🤗': 'hugs', '🤭': 'hand_over_mouth', '🤫': 'shushing_face', '🤔': 'thinking', '🫡': 'saluting_face', '🤐': 'zipper_mouth_face',
  '🤨': 'raised_eyebrow', '😐': 'neutral_face', '😑': 'expressionless', '😶': 'no_mouth', '😏': 'smirk', '😒': 'unamused', '🙄': 'roll_eyes', '😬': 'grimacing',
  '🤥': 'lying_face', '😌': 'relieved', '😔': 'pensive', '😪': 'sleepy', '🤤': 'drooling_face', '😴': 'sleeping', '😷': 'mask', '🤒': 'face_with_thermometer',
  '🤕': 'face_with_head_bandage', '🤢': 'nauseated_face', '🤮': 'vomiting_face', '🤧': 'sneezing_face', '🥵': 'hot_face', '🥶': 'cold_face', '🥴': 'woozy_face', '😵': 'dizzy_face',
  '🤯': 'exploding_head', '🤠': 'cowboy', '🥳': 'partying_face', '🥸': 'disguised_face', '😎': 'sunglasses', '🤓': 'nerd_face', '🧐': 'monocle_face', '😕': 'confused',
  '😟': 'worried', '🙁': 'slightly_frowning_face', '☹️': 'frowning_face', '😮': 'open_mouth', '😯': 'hushed', '😲': 'astonished', '😳': 'flushed', '🥺': 'pleading_face',
  '😦': 'frowning', '😧': 'anguished', '😨': 'fearful', '😰': 'cold_sweat', '😥': 'disappointed_relieved', '😢': 'cry', '😭': 'sob', '😱': 'scream',
  '😖': 'confounded', '😣': 'persevere', '😞': 'disappointed', '😓': 'sweat', '😩': 'weary', '😫': 'tired_face', '🥱': 'yawning_face', '😤': 'triumph',
  '😡': 'rage', '😠': 'angry', '🤬': 'cursing_face', '😈': 'smiling_imp', '👿': 'imp', '💀': 'skull', '👻': 'ghost', '👽': 'alien',
  '🤖': 'robot', '💩': 'poop', '😺': 'smiley_cat', '😸': 'smile_cat', '😹': 'joy_cat', '😻': 'heart_eyes_cat', '😼': 'smirk_cat', '😽': 'kissing_cat',
  '🙀': 'scream_cat', '😿': 'crying_cat_face', '😾': 'pouting_cat', '👍': 'thumbsup', '👎': 'thumbsdown', '👏': 'clap', '🙌': 'raised_hands', '🤝': 'handshake',
  '🙏': 'pray', '💪': 'muscle', '👋': 'wave', '✌️': 'v', '🤞': 'crossed_fingers', '🫶': 'heart_hands', '❤️': 'heart', '🧡': 'orange_heart',
  '💛': 'yellow_heart', '💚': 'green_heart', '💙': 'blue_heart', '💜': 'purple_heart', '🖤': 'black_heart', '🤍': 'white_heart', '🤎': 'brown_heart', '💔': 'broken_heart',
  '❣️': 'heart_exclamation', '💕': 'two_hearts', '💞': 'revolving_hearts', '💓': 'heartbeat', '💗': 'heartpulse', '💖': 'sparkling_heart', '💘': 'cupid', '💝': 'gift_heart',
  '💯': '100', '✅': 'white_check_mark', '❌': 'x', '⭐': 'star', '🌟': 'star2', '✨': 'sparkles', '🔥': 'fire', '🎉': 'tada',
  '🎊': 'confetti_ball', '🎈': 'balloon', '🎁': 'gift', '🏆': 'trophy', '⚡': 'zap', '☀️': 'sunny', '🌈': 'rainbow', '☕': 'coffee',
  '🍕': 'pizza', '🍔': 'hamburger', '🍎': 'apple', '🍺': 'beer', '🎂': 'birthday', '📌': 'pushpin', '🔗': 'link', '📎': 'paperclip',
});

/**
 * `EMOJI_EXTENDED` order, each paired with its shortcode - built once at
 * module load, not per autocomplete keystroke. A glyph missing from
 * `EMOJI_SHORTCODES` (there shouldn't be one - a repo test asserts full
 * coverage) falls back to the glyph itself as its own "name" rather than
 * silently vanishing from `:`-search results.
 * @type {Array<{emoji: string, name: string}>}
 */
export const EMOJI_SHORTCODE_LIST = Object.freeze(
  EMOJI_EXTENDED.map((emoji) => Object.freeze({ emoji, name: EMOJI_SHORTCODES[emoji] ?? emoji }))
);

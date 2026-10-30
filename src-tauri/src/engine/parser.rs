use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// 一条查询文本被解析后的原子单位。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value")]
pub enum QueryToken {
    /// 闭区间数字范围，例如 1024-1035
    Range(u32, u32),
    /// 纯数字核心序号，例如 _DSC8921 -> 8921
    Core(u32),
    /// 完整文件名基准（小写、去扩展名），用于精确捞片
    Stem(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedQuery {
    pub tokens: Vec<QueryToken>,
    /// 每个原始文本片段解析出的 token 组，用于精确统计“失败片段”。
    pub groups: Vec<Vec<QueryToken>>,
    pub raw_segments: usize,
}

/// 单次范围展开上限，避免粘贴恶意文本导致百万级循环。
const MAX_RANGE_SPAN: u32 = 5000;

fn token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[A-Za-z0-9_\-~–—.]+").expect("valid token regex"))
}

fn range_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(\d{2,6})\s*[-~–—]\s*(\d{2,6})$").expect("valid range regex")
    })
}

fn digits_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\d+").expect("valid digit regex"))
}

/// 常见相机文件名前缀，按长度倒序排列，保证最长匹配优先。
const CAMERA_PREFIXES: &[&str] = &[
    "_DSC", "DSCF", "DSCN", "DSC_", "DSC0", "DSC", "IMG_", "IMGP", "IMG", "CIMG", "PANA", "PANO",
    "GOPR", "GPR", "MVI_", "MVI", "VID_", "VID", "SAM_", "SAM", "RIMG", "R001",
];

fn trim_separators(value: &str) -> &str {
    value.trim_start_matches(|c: char| c == '_' || c == '-' || c == '.' || c == ' ')
}

/// 剥离相机前缀与分隔符，返回剩余部分（大写）。
pub fn strip_camera_prefix(raw: &str) -> String {
    let upper = raw.trim().to_uppercase();
    let mut cleaned = trim_separators(&upper).to_string();

    loop {
        let before = cleaned.clone();
        for prefix in CAMERA_PREFIXES {
            if let Some(rest) = cleaned.strip_prefix(prefix) {
                cleaned = trim_separators(rest).to_string();
                break;
            }
        }
        if cleaned == before {
            break;
        }
    }

    // 去掉末尾可能的扩展名（例如残留的 .JPG）
    if let Some((head, _)) = cleaned.rsplit_once('.') {
        if !head.is_empty() {
            return head.to_string();
        }
    }

    cleaned
}

/// 从文件名基准中提取 3–6 位核心序号；优先取最后一个长度 >= 3 的数字串。
pub fn core_number(stem: &str) -> Option<u32> {
    let cleaned = strip_camera_prefix(stem);
    let runs: Vec<&str> = digits_re()
        .find_iter(&cleaned)
        .map(|m| m.as_str())
        .collect();

    let preferred = runs
        .iter()
        .rev()
        .find(|run| run.len() >= 3)
        .copied()
        .or_else(|| runs.last().copied())?;

    let digits: String = preferred.chars().take(6).collect();
    digits.parse::<u32>().ok().filter(|n| *n > 0)
}

/// 解析用户粘贴的一段无规则文本。
pub fn parse_query(text: &str) -> ParsedQuery {
    let mut tokens: Vec<QueryToken> = Vec::new();
    let mut groups: Vec<Vec<QueryToken>> = Vec::new();
    let mut raw_segments = 0usize;

    for mat in token_re().find_iter(text) {
        let raw = mat
            .as_str()
            .trim_matches(|c: char| c == '.' || c == '_' || c == '-');
        if raw.is_empty() {
            continue;
        }
        raw_segments += 1;

        let upper = raw.to_string();
        let mut group: Vec<QueryToken> = Vec::new();

        // 1) 范围：1024-1035 / 8921-25 / 1001~1020
        if let Some(caps) = range_re().captures(&upper) {
            let left_str = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
            let right_str = caps.get(2).map(|m| m.as_str()).unwrap_or_default();
            let left = left_str.parse::<u32>().unwrap_or(0);
            // 简写尾部：8921-25 => 8921..=8925
            let right = if right_str.len() < left_str.len() {
                let keep = left_str.len() - right_str.len();
                format!("{}{}", &left_str[..keep], right_str)
                    .parse::<u32>()
                    .unwrap_or(left)
            } else {
                right_str.parse::<u32>().unwrap_or(left)
            };

            let (low, high) = if left <= right {
                (left, right)
            } else {
                (right, left)
            };
            if high - low <= MAX_RANGE_SPAN {
                push_unique(&mut group, QueryToken::Range(low, high));
            }
            groups.push(group);
            merge_tokens(&mut tokens, &groups);
            continue;
        }

        let has_digit = digits_re().is_match(&upper);
        let has_alpha = upper.chars().any(|c| c.is_ascii_alphabetic());

        if !has_digit {
            if has_alpha && upper.len() >= 2 {
                push_unique(&mut group, QueryToken::Stem(upper.to_lowercase()));
            }
            groups.push(group);
            merge_tokens(&mut tokens, &groups);
            continue;
        }

        // 2) 纯数字核心序号
        if upper.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(value) = upper.parse::<u32>() {
                if value > 0 {
                    push_unique(&mut group, QueryToken::Core(value));
                }
            }
            groups.push(group);
            merge_tokens(&mut tokens, &groups);
            continue;
        }

        // 3) 带前缀的文件名：提取核心数字 + 保留完整 stem 作为兜底
        if let Some(core) = core_number(&upper) {
            push_unique(&mut group, QueryToken::Core(core));
        }
        let stem = upper
            .rsplit_once('.')
            .map(|(head, _)| head)
            .unwrap_or(&upper)
            .to_lowercase();
        if stem.len() >= 2 {
            push_unique(&mut group, QueryToken::Stem(stem));
        }

        groups.push(group);
        merge_tokens(&mut tokens, &groups);
    }

    ParsedQuery {
        tokens,
        groups,
        raw_segments,
    }
}

fn merge_tokens(flat: &mut Vec<QueryToken>, groups: &[Vec<QueryToken>]) {
    for group in groups {
        for token in group {
            push_unique(flat, token.clone());
        }
    }
}

fn push_unique(tokens: &mut Vec<QueryToken>, token: QueryToken) {
    if !tokens.contains(&token) {
        tokens.push(token);
    }
}

/// 判断某个 token 是否命中给定序号。
pub fn token_matches_core(token: &QueryToken, core: Option<u32>) -> bool {
    match (token, core) {
        (QueryToken::Core(value), Some(c)) => *value == c,
        (QueryToken::Range(low, high), Some(c)) => c >= *low && c <= *high,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_common_prefixes() {
        assert_eq!(strip_camera_prefix("_DSC8921"), "8921");
        assert_eq!(strip_camera_prefix("IMG_1024"), "1024");
        assert_eq!(strip_camera_prefix("DSC01234"), "1234");
        assert_eq!(strip_camera_prefix("SAM_1234.JPG"), "1234");
    }

    #[test]
    fn extracts_core_numbers() {
        assert_eq!(core_number("_DSC8921"), Some(8921));
        assert_eq!(core_number("IMG_1024"), Some(1024));
        assert_eq!(core_number("DSC_0042"), Some(42));
        assert_eq!(core_number("photo"), None);
    }

    #[test]
    fn parses_ranges_and_filenames() {
        let parsed = parse_query("1024-1035 与 _DSC8921.JPG 以及 IMG_1024");
        assert!(parsed.tokens.contains(&QueryToken::Range(1024, 1035)));
        assert!(parsed.tokens.contains(&QueryToken::Core(8921)));
        assert!(parsed.tokens.contains(&QueryToken::Core(1024)));
    }
}

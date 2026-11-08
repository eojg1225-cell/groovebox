//! The track types that make sound (src/engine/project.ts SoundKind).

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SoundKind {
    Kick,
    Snare,
    Hat,
    Perc,
    Bass,
    Pad,
    Lead,
    Pluck,
}

impl SoundKind {
    pub const ALL: [SoundKind; 8] = [
        SoundKind::Kick,
        SoundKind::Snare,
        SoundKind::Hat,
        SoundKind::Perc,
        SoundKind::Bass,
        SoundKind::Pad,
        SoundKind::Lead,
        SoundKind::Pluck,
    ];

    /// The id stored in projects and used in the protocol.
    pub fn id(self) -> &'static str {
        match self {
            SoundKind::Kick => "kick",
            SoundKind::Snare => "snare",
            SoundKind::Hat => "hat",
            SoundKind::Perc => "perc",
            SoundKind::Bass => "bass",
            SoundKind::Pad => "pad",
            SoundKind::Lead => "lead",
            SoundKind::Pluck => "pluck",
        }
    }
}

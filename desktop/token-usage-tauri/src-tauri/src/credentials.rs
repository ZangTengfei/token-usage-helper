// Startup may read an already trusted item, but must never open an OS dialog.
// This uses the same file-based Keychain API as keyring's apple-native backend.
pub fn read(service: &str, interactive: bool) -> keyring::Result<String> {
    #[cfg(target_os = "macos")]
    let _interaction_lock = {
        use security_framework::os::macos::keychain::SecKeychain;
        let failure = |e| keyring::Error::PlatformFailure(Box::new(e));
        if !interactive && SecKeychain::user_interaction_allowed().map_err(failure)? {
            Some(SecKeychain::disable_user_interaction().map_err(failure)?)
        } else {
            None
        }
    };
    #[cfg(not(target_os = "macos"))]
    let _ = interactive;
    keyring::Entry::new(service, "upload")?.get_password()
}

pub fn decode(raw: &str, site: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let token = value["token"].as_str()?;
    let suffix = token.strip_prefix("club_usage_")?;
    (value["site"] == site
        && suffix.len() == 43
        && suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    .then(|| token.to_string())
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    static OS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    #[test]
    fn credentials_are_scoped_and_validated() {
        let token = format!("club_usage_{}", "A".repeat(43));
        let raw = serde_json::json!({"site":"https://example.com","token":token}).to_string();
        assert_eq!(super::decode(&raw, "https://example.com"), Some(token));
        assert!(super::decode(&raw, "https://other.example").is_none());
        assert!(super::decode("invalid", "https://example.com").is_none());
        assert!(super::decode(
            r#"{"site":"https://example.com","token":"bad"}"#,
            "https://example.com"
        )
        .is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_silent_missing_read_restores_the_process_interaction_setting() {
        let _guard = OS_TEST_LOCK.lock().unwrap();
        use security_framework::os::macos::keychain::SecKeychain;
        let before = SecKeychain::user_interaction_allowed().unwrap();
        let service = format!("club-usage-missing-test-{}", std::process::id());
        assert!(matches!(
            super::read(&service, false),
            Err(keyring::Error::NoEntry)
        ));
        assert_eq!(SecKeychain::user_interaction_allowed().unwrap(), before);
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn a_self_created_item_can_be_read_without_a_dialog() {
        #[cfg(target_os = "macos")]
        let _guard = OS_TEST_LOCK.lock().unwrap();
        let service = format!("club-usage-self-test-{}", std::process::id());
        let entry = keyring::Entry::new(&service, "upload").unwrap();
        entry.set_password("test-only-placeholder").unwrap();
        let result = super::read(&service, false);
        entry.delete_credential().unwrap();
        assert_eq!(result.unwrap(), "test-only-placeholder");
    }
}

// Startup configuration: required variables, the reader-role check on the JWT,
// and the port.

use data_api_rs::config::{self, Config};

fn b64url(bytes: &[u8]) -> String {
    data_api_rs::base64::encode(bytes)
        .chars()
        .filter(|c| *c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            c => c,
        })
        .collect()
}

fn jwt(payload: serde_json::Value) -> String {
    let header = serde_json::json!({"alg": "HS256", "typ": "JWT"});
    format!(
        "{}.{}.signature",
        b64url(header.to_string().as_bytes()),
        b64url(payload.to_string().as_bytes())
    )
}

fn reader() -> String {
    jwt(serde_json::json!({"role": "data_api_reader", "iss": "supabase"}))
}

fn base() -> Vec<(&'static str, String)> {
    vec![
        ("SUPABASE_URL", "http://kong:8000/".into()),
        ("SUPABASE_ANON_KEY", "anon".into()),
        ("DATA_API_DB_JWT", reader()),
    ]
}

fn load(
    env: &[(&'static str, String)],
    over: &[(&'static str, Option<&str>)],
) -> Result<Config, String> {
    let mut vars: Vec<(&str, Option<String>)> =
        env.iter().map(|(k, v)| (*k, Some(v.clone()))).collect();
    for (k, v) in over {
        vars.retain(|(n, _)| n != k);
        vars.push((k, v.map(str::to_string)));
    }
    config::load(&|name| {
        vars.iter()
            .find(|(n, _)| *n == name)
            .and_then(|(_, v)| v.clone())
    })
}

#[test]
fn accepts_a_reader_jwt_and_defaults_the_port() {
    let c = load(&base(), &[]).unwrap();
    assert_eq!(c.supabase_url, "http://kong:8000");
    assert_eq!(c.anon_key, "anon");
    assert_eq!(c.db_jwt, reader());
    assert_eq!(c.port, 8080);
    assert_eq!(load(&base(), &[("PORT", Some("9000"))]).unwrap().port, 9000);
}

#[test]
fn refuses_to_start_without_each_required_variable() {
    for name in ["SUPABASE_URL", "SUPABASE_ANON_KEY", "DATA_API_DB_JWT"] {
        assert!(load(&base(), &[(name, None)]).is_err(), "{name}");
        let err = load(&base(), &[(name, Some("  "))]).unwrap_err();
        assert!(err.contains(name), "{err}");
    }
}

#[test]
fn refuses_a_jwt_for_any_other_role_without_printing_it() {
    for role in ["service_role", "anon", "authenticated"] {
        let token = jwt(serde_json::json!({"role": role, "iss": "supabase"}));
        let err = load(&base(), &[("DATA_API_DB_JWT", Some(&token))]).unwrap_err();
        assert!(!err.contains(&token), "{err}");
    }
}

#[test]
fn refuses_something_that_is_not_a_jwt_at_all() {
    let err = load(&base(), &[("DATA_API_DB_JWT", Some("sb_secret_abc"))]).unwrap_err();
    assert!(err.contains("no readable role"), "{err}");
    let no_role = jwt(serde_json::json!({"iss": "supabase"}));
    assert!(load(&base(), &[("DATA_API_DB_JWT", Some(&no_role))]).is_err());
}

#[test]
fn refuses_a_bad_url_or_port() {
    assert!(load(&base(), &[("SUPABASE_URL", Some("kong"))]).is_err());
    assert!(load(&base(), &[("PORT", Some("eighty"))]).is_err());
}

#[test]
fn the_config_debug_output_never_carries_a_credential() {
    let c = load(&base(), &[]).unwrap();
    let shown = format!("{c:?}");
    assert!(
        !shown.contains("anon") && !shown.contains(&reader()),
        "{shown}"
    );
}

#[test]
fn jwt_role_reads_the_role_claim_without_verifying() {
    assert_eq!(
        config::jwt_role(&reader()).as_deref(),
        Some("data_api_reader")
    );
    assert_eq!(config::jwt_role("a.b"), None);
    assert_eq!(config::jwt_role("a.!!!.c"), None);
}

#[test]
fn takes_the_upstream_concurrency_cap_from_the_environment_and_defaults_it_to_16() {
    let cap = |raw: Option<&str>| {
        load(&base(), &[("DATA_API_UPSTREAM_CONCURRENCY", raw)]).map(|c| c.upstream_concurrency)
    };
    assert_eq!(cap(None), Ok(16));
    assert_eq!(cap(Some("  ")), Ok(16));
    assert_eq!(cap(Some("4")), Ok(4));
    assert_eq!(cap(Some(" 1024 ")), Ok(1024));
    // Number('0x10') is 16, as the TypeScript service reads it.
    assert_eq!(cap(Some("0x10")), Ok(16));
    for bad in ["0", "-1", "1025", "2.5", "many", "1e9"] {
        assert_eq!(
            cap(Some(bad)),
            Err("DATA_API_UPSTREAM_CONCURRENCY must be an integer between 1 and 1024".to_string()),
            "{bad}"
        );
    }
}

// ############################################################################
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Produced by scripts/gen-db-types.mjs, which reads pg_class, pg_attribute,
// pg_constraint, pg_proc and pg_enum straight out of the running database over
// ssh. Regenerate with:
//
//   npm run gen:types
//
// which is:
//
//   node scripts/gen-db-types.mjs --profile production
//
// SOURCE DATABASE: production, database "postgres", schemas
// graphql_public,public.
//
// Covers 71 tables, 3 views and 26 enums.
//
// A hand edit here is lost on the next run, and a hand-edited .gen.ts is
// fiction that looks generated. If something below is wrong, the fix belongs
// in the schema or in the generator, never in this file.
//
// There is deliberately NO generation timestamp: the output is a pure function
// of the schema, so re-running against an unchanged database rewrites this file
// byte for byte and every diff is a real schema change.
//
// NOT EXPRESSED HERE. View relationships are not computed — a view reporting
// "Relationships: []" means "not traced", not "none exist". Tables report
// theirs in full.
// This schema has no composite types and no domains, so the CompositeTypes
// slot is empty for the honest reason.
// ############################################################################

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      announcement_reads: {
        Row: {
          announcement_id: string
          id: string
          player_id: string
          read_at: string
        }
        Insert: {
          announcement_id: string
          id?: string
          player_id: string
          read_at?: string
        }
        Update: {
          announcement_id?: string
          id?: string
          player_id?: string
          read_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_reads_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcement_reads_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      announcements: {
        Row: {
          all_seasons: boolean
          author_id: string | null
          body: string
          created_at: string
          expires_at: string | null
          id: string
          pinned: boolean
          season_id: string | null
          send_push: boolean
          status: Database["public"]["Enums"]["announcement_status"]
          target_audience: Database["public"]["Enums"]["announcement_audience"]
          title: string
          type: Database["public"]["Enums"]["announcement_type"]
          updated_at: string
        }
        Insert: {
          all_seasons?: boolean
          author_id?: string | null
          body?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          pinned?: boolean
          season_id?: string | null
          send_push?: boolean
          status?: Database["public"]["Enums"]["announcement_status"]
          target_audience?: Database["public"]["Enums"]["announcement_audience"]
          title: string
          type?: Database["public"]["Enums"]["announcement_type"]
          updated_at?: string
        }
        Update: {
          all_seasons?: boolean
          author_id?: string | null
          body?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          pinned?: boolean
          season_id?: string | null
          send_push?: boolean
          status?: Database["public"]["Enums"]["announcement_status"]
          target_audience?: Database["public"]["Enums"]["announcement_audience"]
          title?: string
          type?: Database["public"]["Enums"]["announcement_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcements_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action_type: string
          actor_id: string | null
          created_at: string
          id: string
          new_value: Json | null
          old_value: Json | null
          reason: string | null
          target_id: string | null
          target_type: string
        }
        Insert: {
          action_type: string
          actor_id?: string | null
          created_at?: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          reason?: string | null
          target_id?: string | null
          target_type: string
        }
        Update: {
          action_type?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          reason?: string | null
          target_id?: string | null
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_feed_tokens: {
        Row: {
          created_at: string
          player_id: string
          token: string
        }
        Insert: {
          created_at?: string
          player_id: string
          token: string
        }
        Update: {
          created_at?: string
          player_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_feed_tokens_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      challenge_participants: {
        Row: {
          challenge_id: string
          confirmation_status: Database["public"]["Enums"]["confirmation_status"]
          id: string
          player_id: string
          responded_at: string | null
          role: Database["public"]["Enums"]["participant_role"]
          team_side: Database["public"]["Enums"]["team_side"]
        }
        Insert: {
          challenge_id: string
          confirmation_status?: Database["public"]["Enums"]["confirmation_status"]
          id?: string
          player_id: string
          responded_at?: string | null
          role: Database["public"]["Enums"]["participant_role"]
          team_side: Database["public"]["Enums"]["team_side"]
        }
        Update: {
          challenge_id?: string
          confirmation_status?: Database["public"]["Enums"]["confirmation_status"]
          id?: string
          player_id?: string
          responded_at?: string | null
          role?: Database["public"]["Enums"]["participant_role"]
          team_side?: Database["public"]["Enums"]["team_side"]
        }
        Relationships: [
          {
            foreignKeyName: "challenge_participants_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "challenge_participants_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      challenges: {
        Row: {
          created_at: string
          created_by: string
          event_type: Database["public"]["Enums"]["event_type_enum"]
          expires_at: string
          format: Database["public"]["Enums"]["match_format"]
          games_per_match: number | null
          id: string
          note: string | null
          points_per_game: number | null
          rated_flag: boolean
          scheduled_date: string | null
          scheduled_time: string | null
          session_id: string | null
          status: Database["public"]["Enums"]["challenge_status"]
          type: Database["public"]["Enums"]["match_type_enum"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          event_type?: Database["public"]["Enums"]["event_type_enum"]
          expires_at?: string
          format?: Database["public"]["Enums"]["match_format"]
          games_per_match?: number | null
          id?: string
          note?: string | null
          points_per_game?: number | null
          rated_flag?: boolean
          scheduled_date?: string | null
          scheduled_time?: string | null
          session_id?: string | null
          status?: Database["public"]["Enums"]["challenge_status"]
          type: Database["public"]["Enums"]["match_type_enum"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          event_type?: Database["public"]["Enums"]["event_type_enum"]
          expires_at?: string
          format?: Database["public"]["Enums"]["match_format"]
          games_per_match?: number | null
          id?: string
          note?: string | null
          points_per_game?: number | null
          rated_flag?: boolean
          scheduled_date?: string | null
          scheduled_time?: string | null
          session_id?: string | null
          status?: Database["public"]["Enums"]["challenge_status"]
          type?: Database["public"]["Enums"]["match_type_enum"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "challenges_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "challenges_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      club_change_drafts: {
        Row: {
          changed_at: string
          created_at: string
          field: string | null
          first_actor_id: string | null
          from_value: Json | null
          id: string
          last_actor_id: string | null
          override_to_value: Json | null
          revision: number
          source: string
          subject: string | null
          text_override: string | null
          to_value: Json | null
        }
        Insert: {
          changed_at?: string
          created_at?: string
          field?: string | null
          first_actor_id?: string | null
          from_value?: Json | null
          id?: string
          last_actor_id?: string | null
          override_to_value?: Json | null
          revision?: number
          source: string
          subject?: string | null
          text_override?: string | null
          to_value?: Json | null
        }
        Update: {
          changed_at?: string
          created_at?: string
          field?: string | null
          first_actor_id?: string | null
          from_value?: Json | null
          id?: string
          last_actor_id?: string | null
          override_to_value?: Json | null
          revision?: number
          source?: string
          subject?: string | null
          text_override?: string | null
          to_value?: Json | null
        }
        Relationships: []
      }
      club_change_entries: {
        Row: {
          announcement_id: string | null
          id: string
          intro: string | null
          lines: Json
          posted_at: string
          posted_by: string | null
          title: string | null
        }
        Insert: {
          announcement_id?: string | null
          id?: string
          intro?: string | null
          lines: Json
          posted_at?: string
          posted_by?: string | null
          title?: string | null
        }
        Update: {
          announcement_id?: string | null
          id?: string
          intro?: string | null
          lines?: Json
          posted_at?: string
          posted_by?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "club_change_entries_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
        ]
      }
      club_fees: {
        Row: {
          amount_cents: number | null
          ban_reason: string | null
          ban_started_at: string | null
          created_at: string
          fee_type: string
          id: string
          manual_name: string | null
          marked_by: string | null
          method: string | null
          paid_at: string | null
          player_id: string | null
          reference: string | null
          season_id: string | null
          tier_id: string | null
          tournament_id: string | null
        }
        Insert: {
          amount_cents?: number | null
          ban_reason?: string | null
          ban_started_at?: string | null
          created_at?: string
          fee_type?: string
          id?: string
          manual_name?: string | null
          marked_by?: string | null
          method?: string | null
          paid_at?: string | null
          player_id?: string | null
          reference?: string | null
          season_id?: string | null
          tier_id?: string | null
          tournament_id?: string | null
        }
        Update: {
          amount_cents?: number | null
          ban_reason?: string | null
          ban_started_at?: string | null
          created_at?: string
          fee_type?: string
          id?: string
          manual_name?: string | null
          marked_by?: string | null
          method?: string | null
          paid_at?: string | null
          player_id?: string | null
          reference?: string | null
          season_id?: string | null
          tier_id?: string | null
          tournament_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "club_fees_marked_by_fkey"
            columns: ["marked_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_fees_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_fees_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_fees_tier_id_fkey"
            columns: ["tier_id"]
            isOneToOne: false
            referencedRelation: "tournament_fee_tiers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_fees_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      club_ledger: {
        Row: {
          amount_cents: number
          category: string
          created_at: string
          description: string
          direction: string
          id: string
          marked_by: string | null
          method: string | null
          paid_at: string | null
          paid_by: string | null
          quantity: number | null
          receipt_path: string | null
          ref_no: number
          reference: string | null
          reimbursed_at: string | null
          reimbursed_by: string | null
          season_id: string
        }
        Insert: {
          amount_cents: number
          category: string
          created_at?: string
          description: string
          direction: string
          id?: string
          marked_by?: string | null
          method?: string | null
          paid_at?: string | null
          paid_by?: string | null
          quantity?: number | null
          receipt_path?: string | null
          ref_no?: number
          reference?: string | null
          reimbursed_at?: string | null
          reimbursed_by?: string | null
          season_id: string
        }
        Update: {
          amount_cents?: number
          category?: string
          created_at?: string
          description?: string
          direction?: string
          id?: string
          marked_by?: string | null
          method?: string | null
          paid_at?: string | null
          paid_by?: string | null
          quantity?: number | null
          receipt_path?: string | null
          ref_no?: number
          reference?: string | null
          reimbursed_at?: string | null
          reimbursed_by?: string | null
          season_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "club_ledger_marked_by_fkey"
            columns: ["marked_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_ledger_paid_by_fkey"
            columns: ["paid_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_ledger_reimbursed_by_fkey"
            columns: ["reimbursed_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "club_ledger_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      console_passkey_grace: {
        Row: {
          started_at: string
          user_id: string
        }
        Insert: {
          started_at?: string
          user_id: string
        }
        Update: {
          started_at?: string
          user_id?: string
        }
        Relationships: []
      }
      cron_config: {
        Row: {
          key: string
          value: string
        }
        Insert: {
          key: string
          value: string
        }
        Update: {
          key?: string
          value?: string
        }
        Relationships: []
      }
      digest_deliveries: {
        Row: {
          claimed_at: string
          completed_at: string | null
          outcome: string | null
          player_id: string
          provider_message_id: string | null
          week_start: string
        }
        Insert: {
          claimed_at?: string
          completed_at?: string | null
          outcome?: string | null
          player_id: string
          provider_message_id?: string | null
          week_start: string
        }
        Update: {
          claimed_at?: string
          completed_at?: string | null
          outcome?: string | null
          player_id?: string
          provider_message_id?: string | null
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "digest_deliveries_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      discord_announcement_posts: {
        Row: {
          announcement_id: string
          channel_id: string
          created_at: string
          discord_message_id: string
          guild_id: string
          synced_body: string
          synced_title: string
          synced_type: string
          updated_at: string
        }
        Insert: {
          announcement_id: string
          channel_id: string
          created_at?: string
          discord_message_id: string
          guild_id: string
          synced_body: string
          synced_title: string
          synced_type: string
          updated_at?: string
        }
        Update: {
          announcement_id?: string
          channel_id?: string
          created_at?: string
          discord_message_id?: string
          guild_id?: string
          synced_body?: string
          synced_title?: string
          synced_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      discord_feedback_posts: {
        Row: {
          channel_id: string
          created_at: string
          discord_message_id: string
          guild_id: string
          source: string
          source_id: string
          synced_summary: string
          updated_at: string
        }
        Insert: {
          channel_id: string
          created_at?: string
          discord_message_id: string
          guild_id: string
          source: string
          source_id: string
          synced_summary: string
          updated_at?: string
        }
        Update: {
          channel_id?: string
          created_at?: string
          discord_message_id?: string
          guild_id?: string
          source?: string
          source_id?: string
          synced_summary?: string
          updated_at?: string
        }
        Relationships: []
      }
      discord_guild_roles: {
        Row: {
          guild_id: string
          role_id: string
          role_name: string
        }
        Insert: {
          guild_id: string
          role_id: string
          role_name: string
        }
        Update: {
          guild_id?: string
          role_id?: string
          role_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "discord_guild_roles_guild_id_fkey"
            columns: ["guild_id"]
            isOneToOne: false
            referencedRelation: "discord_guilds"
            referencedColumns: ["guild_id"]
          },
        ]
      }
      discord_guilds: {
        Row: {
          created_at: string
          enabled: boolean
          guild_id: string
          label: string | null
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          guild_id: string
          label?: string | null
        }
        Update: {
          created_at?: string
          enabled?: boolean
          guild_id?: string
          label?: string | null
        }
        Relationships: []
      }
      discord_link_tokens: {
        Row: {
          consumed_at: string | null
          consumed_by: string | null
          created_at: string
          discord_user_id: string
          expires_at: string
          guild_id: string | null
          token_hash: string
        }
        Insert: {
          consumed_at?: string | null
          consumed_by?: string | null
          created_at?: string
          discord_user_id: string
          expires_at: string
          guild_id?: string | null
          token_hash: string
        }
        Update: {
          consumed_at?: string | null
          consumed_by?: string | null
          created_at?: string
          discord_user_id?: string
          expires_at?: string
          guild_id?: string | null
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "discord_link_tokens_consumed_by_fkey"
            columns: ["consumed_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      discord_match_posts: {
        Row: {
          channel_id: string
          created_at: string
          discord_message_id: string
          guild_id: string
          match_id: string
          synced_summary: string
          updated_at: string
        }
        Insert: {
          channel_id: string
          created_at?: string
          discord_message_id: string
          guild_id: string
          match_id: string
          synced_summary: string
          updated_at?: string
        }
        Update: {
          channel_id?: string
          created_at?: string
          discord_message_id?: string
          guild_id?: string
          match_id?: string
          synced_summary?: string
          updated_at?: string
        }
        Relationships: []
      }
      discord_outbox: {
        Row: {
          attempts: number
          button_set: string | null
          channel_id: string
          claimed_at: string | null
          content: string | null
          created_at: string
          discord_message_id: string | null
          embed_body: string | null
          embed_title: string | null
          embed_type: string | null
          failed_at: string | null
          guild_id: string
          id: string
          last_error: string | null
          ping: boolean
          requested_by: string | null
          sent_at: string | null
        }
        Insert: {
          attempts?: number
          button_set?: string | null
          channel_id: string
          claimed_at?: string | null
          content?: string | null
          created_at?: string
          discord_message_id?: string | null
          embed_body?: string | null
          embed_title?: string | null
          embed_type?: string | null
          failed_at?: string | null
          guild_id: string
          id?: string
          last_error?: string | null
          ping?: boolean
          requested_by?: string | null
          sent_at?: string | null
        }
        Update: {
          attempts?: number
          button_set?: string | null
          channel_id?: string
          claimed_at?: string | null
          content?: string | null
          created_at?: string
          discord_message_id?: string | null
          embed_body?: string | null
          embed_title?: string | null
          embed_type?: string | null
          failed_at?: string | null
          guild_id?: string
          id?: string
          last_error?: string | null
          ping?: boolean
          requested_by?: string | null
          sent_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "discord_outbox_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      discord_role_revocations: {
        Row: {
          discord_user_id: string
          queued_at: string
        }
        Insert: {
          discord_user_id: string
          queued_at?: string
        }
        Update: {
          discord_user_id?: string
          queued_at?: string
        }
        Relationships: []
      }
      discord_self_roles: {
        Row: {
          channel_id: string | null
          created_at: string
          emoji: string | null
          guild_id: string
          label: string
          role_id: string
          sort_order: number
          track: Database["public"]["Enums"]["session_group"] | null
        }
        Insert: {
          channel_id?: string | null
          created_at?: string
          emoji?: string | null
          guild_id: string
          label: string
          role_id: string
          sort_order?: number
          track?: Database["public"]["Enums"]["session_group"] | null
        }
        Update: {
          channel_id?: string | null
          created_at?: string
          emoji?: string | null
          guild_id?: string
          label?: string
          role_id?: string
          sort_order?: number
          track?: Database["public"]["Enums"]["session_group"] | null
        }
        Relationships: [
          {
            foreignKeyName: "discord_self_roles_guild_id_fkey"
            columns: ["guild_id"]
            isOneToOne: false
            referencedRelation: "discord_guilds"
            referencedColumns: ["guild_id"]
          },
        ]
      }
      discord_server_roles: {
        Row: {
          guild_id: string
          position: number | null
          role_id: string
          role_name: string
          synced_at: string
        }
        Insert: {
          guild_id: string
          position?: number | null
          role_id: string
          role_name: string
          synced_at?: string
        }
        Update: {
          guild_id?: string
          position?: number | null
          role_id?: string
          role_name?: string
          synced_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "discord_server_roles_guild_id_fkey"
            columns: ["guild_id"]
            isOneToOne: false
            referencedRelation: "discord_guilds"
            referencedColumns: ["guild_id"]
          },
        ]
      }
      discord_session_pings: {
        Row: {
          pinged_at: string
          role_id: string
          session_id: string
        }
        Insert: {
          pinged_at?: string
          role_id: string
          session_id: string
        }
        Update: {
          pinged_at?: string
          role_id?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "discord_session_pings_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      discord_settings: {
        Row: {
          key: string
          value: string | null
        }
        Insert: {
          key: string
          value?: string | null
        }
        Update: {
          key?: string
          value?: string | null
        }
        Relationships: []
      }
      discord_signup_attempts: {
        Row: {
          created_at: string
          discord_user_id: string
          email_digest: string | null
          id: number
          kind: string
        }
        Insert: {
          created_at?: string
          discord_user_id: string
          email_digest?: string | null
          id?: never
          kind: string
        }
        Update: {
          created_at?: string
          discord_user_id?: string
          email_digest?: string | null
          id?: never
          kind?: string
        }
        Relationships: []
      }
      discord_signup_drafts: {
        Row: {
          accepted: Json
          age_attestation: boolean
          code_sent_at: string | null
          competition_category: string | null
          completing_at: string | null
          created_at: string
          discord_user_id: string
          display_name: string | null
          email: string
          expires_at: string
          first_name: string
          gender_answered: boolean
          last_name: string
          media_consent: boolean | null
          phone: string | null
          send_count: number
          skill_tier: string | null
          verify_attempts: number
        }
        Insert: {
          accepted?: Json
          age_attestation?: boolean
          code_sent_at?: string | null
          competition_category?: string | null
          completing_at?: string | null
          created_at?: string
          discord_user_id: string
          display_name?: string | null
          email: string
          expires_at?: string
          first_name: string
          gender_answered?: boolean
          last_name: string
          media_consent?: boolean | null
          phone?: string | null
          send_count?: number
          skill_tier?: string | null
          verify_attempts?: number
        }
        Update: {
          accepted?: Json
          age_attestation?: boolean
          code_sent_at?: string | null
          competition_category?: string | null
          completing_at?: string | null
          created_at?: string
          discord_user_id?: string
          display_name?: string | null
          email?: string
          expires_at?: string
          first_name?: string
          gender_answered?: boolean
          last_name?: string
          media_consent?: boolean | null
          phone?: string | null
          send_count?: number
          skill_tier?: string | null
          verify_attempts?: number
        }
        Relationships: []
      }
      discord_tournament_events: {
        Row: {
          created_at: string
          discord_event_id: string
          guild_id: string
          synced_ends_at: string
          synced_name: string
          synced_starts_at: string
          tournament_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          discord_event_id: string
          guild_id: string
          synced_ends_at: string
          synced_name: string
          synced_starts_at: string
          tournament_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          discord_event_id?: string
          guild_id?: string
          synced_ends_at?: string
          synced_name?: string
          synced_starts_at?: string
          tournament_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      disputes: {
        Row: {
          claimed_at: string | null
          claimed_by: string | null
          claimed_resolution_type: Database["public"]["Enums"]["dispute_resolution"] | null
          created_at: string
          description: string
          id: string
          match_id: string
          opened_by: string
          reason_category: Database["public"]["Enums"]["dispute_reason"]
          resolution_note: string | null
          resolution_type: Database["public"]["Enums"]["dispute_resolution"] | null
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["dispute_status"]
          updated_at: string
        }
        Insert: {
          claimed_at?: string | null
          claimed_by?: string | null
          claimed_resolution_type?: Database["public"]["Enums"]["dispute_resolution"] | null
          created_at?: string
          description: string
          id?: string
          match_id: string
          opened_by: string
          reason_category: Database["public"]["Enums"]["dispute_reason"]
          resolution_note?: string | null
          resolution_type?: Database["public"]["Enums"]["dispute_resolution"] | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["dispute_status"]
          updated_at?: string
        }
        Update: {
          claimed_at?: string | null
          claimed_by?: string | null
          claimed_resolution_type?: Database["public"]["Enums"]["dispute_resolution"] | null
          created_at?: string
          description?: string
          id?: string
          match_id?: string
          opened_by?: string
          reason_category?: Database["public"]["Enums"]["dispute_reason"]
          resolution_note?: string | null
          resolution_type?: Database["public"]["Enums"]["dispute_resolution"] | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["dispute_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "disputes_claimed_by_fkey"
            columns: ["claimed_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_opened_by_fkey"
            columns: ["opened_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      email_suppressions: {
        Row: {
          created_at: string
          detail: Json | null
          email: string
          reason: string
        }
        Insert: {
          created_at?: string
          detail?: Json | null
          email: string
          reason: string
        }
        Update: {
          created_at?: string
          detail?: Json | null
          email?: string
          reason?: string
        }
        Relationships: []
      }
      event_waiver_acceptances: {
        Row: {
          accepted_at: string
          id: string
          player_id: string
          tournament_id: string
          user_agent: string | null
          waiver_hash: string
        }
        Insert: {
          accepted_at?: string
          id?: string
          player_id: string
          tournament_id: string
          user_agent?: string | null
          waiver_hash: string
        }
        Update: {
          accepted_at?: string
          id?: string
          player_id?: string
          tournament_id?: string
          user_agent?: string | null
          waiver_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_waiver_acceptances_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_waiver_acceptances_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      event_waiver_templates: {
        Row: {
          content: string
          season_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          content: string
          season_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          content?: string
          season_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "event_waiver_templates_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: true
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_waiver_templates_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback_reports: {
        Row: {
          body: string | null
          created_at: string
          discord_user_id: string | null
          guild_id: string | null
          id: string
          image_path: string | null
          image_url: string | null
          kind: string
          player_id: string | null
          rating: number | null
          source: string
          status: string
          title: string | null
          tournament_id: string | null
          updated_at: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          discord_user_id?: string | null
          guild_id?: string | null
          id?: string
          image_path?: string | null
          image_url?: string | null
          kind: string
          player_id?: string | null
          rating?: number | null
          source?: string
          status?: string
          title?: string | null
          tournament_id?: string | null
          updated_at?: string
        }
        Update: {
          body?: string | null
          created_at?: string
          discord_user_id?: string | null
          guild_id?: string | null
          id?: string
          image_path?: string | null
          image_url?: string | null
          kind?: string
          player_id?: string | null
          rating?: number | null
          source?: string
          status?: string
          title?: string | null
          tournament_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_reports_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_reports_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      head_to_head_stats: {
        Row: {
          id: string
          last_played_at: string | null
          match_type: Database["public"]["Enums"]["match_type_enum"]
          player_a_id: string
          player_a_points: number
          player_a_wins: number
          player_b_id: string
          player_b_points: number
          player_b_wins: number
          total_matches: number
          updated_at: string
        }
        Insert: {
          id?: string
          last_played_at?: string | null
          match_type: Database["public"]["Enums"]["match_type_enum"]
          player_a_id: string
          player_a_points?: number
          player_a_wins?: number
          player_b_id: string
          player_b_points?: number
          player_b_wins?: number
          total_matches?: number
          updated_at?: string
        }
        Update: {
          id?: string
          last_played_at?: string | null
          match_type?: Database["public"]["Enums"]["match_type_enum"]
          player_a_id?: string
          player_a_points?: number
          player_a_wins?: number
          player_b_id?: string
          player_b_points?: number
          player_b_wins?: number
          total_matches?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "head_to_head_stats_player_a_id_fkey"
            columns: ["player_a_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "head_to_head_stats_player_b_id_fkey"
            columns: ["player_b_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      legacy_tournament_participants: {
        Row: {
          bonus_applied: number | null
          id: string
          partner_id: string | null
          placement: number | null
          player_id: string
          seed: number | null
          tournament_id: string
        }
        Insert: {
          bonus_applied?: number | null
          id?: string
          partner_id?: string | null
          placement?: number | null
          player_id: string
          seed?: number | null
          tournament_id: string
        }
        Update: {
          bonus_applied?: number | null
          id?: string
          partner_id?: string | null
          placement?: number | null
          player_id?: string
          seed?: number | null
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "legacy_tournament_participants_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legacy_tournament_participants_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "legacy_tournament_participants_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      legal_documents: {
        Row: {
          content: string
          document: string
          reacceptance_required_since: string | null
          updated_at: string
          updated_by: string | null
          version: string
        }
        Insert: {
          content: string
          document: string
          reacceptance_required_since?: string | null
          updated_at?: string
          updated_by?: string | null
          version: string
        }
        Update: {
          content?: string
          document?: string
          reacceptance_required_since?: string | null
          updated_at?: string
          updated_by?: string | null
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "legal_documents_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      match_admin_notes: {
        Row: {
          author_id: string | null
          created_at: string
          match_id: string
          note: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          match_id: string
          note: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          match_id?: string
          note?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "match_admin_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_admin_notes_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: true
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
        ]
      }
      match_games: {
        Row: {
          game_number: number
          id: string
          match_id: string
          side_a_score: number
          side_b_score: number
        }
        Insert: {
          game_number: number
          id?: string
          match_id: string
          side_a_score?: number
          side_b_score?: number
        }
        Update: {
          game_number?: number
          id?: string
          match_id?: string
          side_a_score?: number
          side_b_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "match_games_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
        ]
      }
      match_participants: {
        Row: {
          games_lost: number
          games_won: number
          id: string
          match_id: string
          player_id: string
          points_allowed: number
          points_scored: number
          post_rating: number | null
          pre_rating: number
          rating_delta: number | null
          team_side: Database["public"]["Enums"]["team_side"]
          win_flag: boolean | null
        }
        Insert: {
          games_lost?: number
          games_won?: number
          id?: string
          match_id: string
          player_id: string
          points_allowed?: number
          points_scored?: number
          post_rating?: number | null
          pre_rating?: number
          rating_delta?: number | null
          team_side: Database["public"]["Enums"]["team_side"]
          win_flag?: boolean | null
        }
        Update: {
          games_lost?: number
          games_won?: number
          id?: string
          match_id?: string
          player_id?: string
          points_allowed?: number
          points_scored?: number
          post_rating?: number | null
          pre_rating?: number
          rating_delta?: number | null
          team_side?: Database["public"]["Enums"]["team_side"]
          win_flag?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "match_participants_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_participants_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      matches: {
        Row: {
          challenge_id: string | null
          completed_flag: boolean
          confirmed_by: string | null
          created_at: string
          duration_minutes: number | null
          elo_boost: number | null
          elo_weight_override: number | null
          event_multiplier: number
          event_type: Database["public"]["Enums"]["event_type_enum"]
          forfeit_player_id: string | null
          format: Database["public"]["Enums"]["match_format"]
          format_weight: number
          games_per_match: number | null
          id: string
          match_type: Database["public"]["Enums"]["match_type_enum"]
          notice_hours: number | null
          played_at: string | null
          points_per_game: number | null
          rated_flag: boolean
          repeat_factor: number | null
          repeat_index: number | null
          result_status: Database["public"]["Enums"]["result_status"]
          score_summary: string | null
          season_id: string | null
          session_id: string | null
          submitted_by: string | null
          tournament_id: string | null
          updated_at: string
          walkover_type: Database["public"]["Enums"]["walkover_type"] | null
          winner_side: Database["public"]["Enums"]["team_side"] | null
        }
        Insert: {
          challenge_id?: string | null
          completed_flag?: boolean
          confirmed_by?: string | null
          created_at?: string
          duration_minutes?: number | null
          elo_boost?: number | null
          elo_weight_override?: number | null
          event_multiplier?: number
          event_type?: Database["public"]["Enums"]["event_type_enum"]
          forfeit_player_id?: string | null
          format?: Database["public"]["Enums"]["match_format"]
          format_weight?: number
          games_per_match?: number | null
          id?: string
          match_type: Database["public"]["Enums"]["match_type_enum"]
          notice_hours?: number | null
          played_at?: string | null
          points_per_game?: number | null
          rated_flag?: boolean
          repeat_factor?: number | null
          repeat_index?: number | null
          result_status?: Database["public"]["Enums"]["result_status"]
          score_summary?: string | null
          season_id?: string | null
          session_id?: string | null
          submitted_by?: string | null
          tournament_id?: string | null
          updated_at?: string
          walkover_type?: Database["public"]["Enums"]["walkover_type"] | null
          winner_side?: Database["public"]["Enums"]["team_side"] | null
        }
        Update: {
          challenge_id?: string | null
          completed_flag?: boolean
          confirmed_by?: string | null
          created_at?: string
          duration_minutes?: number | null
          elo_boost?: number | null
          elo_weight_override?: number | null
          event_multiplier?: number
          event_type?: Database["public"]["Enums"]["event_type_enum"]
          forfeit_player_id?: string | null
          format?: Database["public"]["Enums"]["match_format"]
          format_weight?: number
          games_per_match?: number | null
          id?: string
          match_type?: Database["public"]["Enums"]["match_type_enum"]
          notice_hours?: number | null
          played_at?: string | null
          points_per_game?: number | null
          rated_flag?: boolean
          repeat_factor?: number | null
          repeat_index?: number | null
          result_status?: Database["public"]["Enums"]["result_status"]
          score_summary?: string | null
          season_id?: string | null
          session_id?: string | null
          submitted_by?: string | null
          tournament_id?: string | null
          updated_at?: string
          walkover_type?: Database["public"]["Enums"]["walkover_type"] | null
          winner_side?: Database["public"]["Enums"]["team_side"] | null
        }
        Relationships: [
          {
            foreignKeyName: "matches_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_forfeit_player_id_fkey"
            columns: ["forfeit_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          metadata: Json | null
          player_id: string
          read_flag: boolean
          title: string
          type: Database["public"]["Enums"]["notification_type"]
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          player_id: string
          read_flag?: boolean
          title: string
          type: Database["public"]["Enums"]["notification_type"]
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          player_id?: string
          read_flag?: boolean
          title?: string
          type?: Database["public"]["Enums"]["notification_type"]
        }
        Relationships: [
          {
            foreignKeyName: "notifications_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      partnership_stats: {
        Row: {
          avg_elo_delta: number
          id: string
          last_played_at: string | null
          losses: number
          matches_played: number
          player_a_id: string
          player_b_id: string
          total_points_conceded: number
          total_points_scored: number
          updated_at: string
          win_rate: number
          wins: number
        }
        Insert: {
          avg_elo_delta?: number
          id?: string
          last_played_at?: string | null
          losses?: number
          matches_played?: number
          player_a_id: string
          player_b_id: string
          total_points_conceded?: number
          total_points_scored?: number
          updated_at?: string
          win_rate?: number
          wins?: number
        }
        Update: {
          avg_elo_delta?: number
          id?: string
          last_played_at?: string | null
          losses?: number
          matches_played?: number
          player_a_id?: string
          player_b_id?: string
          total_points_conceded?: number
          total_points_scored?: number
          updated_at?: string
          win_rate?: number
          wins?: number
        }
        Relationships: [
          {
            foreignKeyName: "partnership_stats_player_a_id_fkey"
            columns: ["player_a_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partnership_stats_player_b_id_fkey"
            columns: ["player_b_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      passkey_challenges: {
        Row: {
          challenge_hash: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          purpose: string
          user_id: string | null
        }
        Insert: {
          challenge_hash: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          purpose: string
          user_id?: string | null
        }
        Update: {
          challenge_hash?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          purpose?: string
          user_id?: string | null
        }
        Relationships: []
      }
      passkey_credentials: {
        Row: {
          backed_up: boolean | null
          counter: number
          created_at: string
          credential_id: string
          device_type: string | null
          enrolled_via: string
          id: string
          last_used_at: string | null
          nickname: string | null
          player_id: string
          public_key: string
          transports: string[] | null
        }
        Insert: {
          backed_up?: boolean | null
          counter?: number
          created_at?: string
          credential_id: string
          device_type?: string | null
          enrolled_via?: string
          id?: string
          last_used_at?: string | null
          nickname?: string | null
          player_id: string
          public_key: string
          transports?: string[] | null
        }
        Update: {
          backed_up?: boolean | null
          counter?: number
          created_at?: string
          credential_id?: string
          device_type?: string | null
          enrolled_via?: string
          id?: string
          last_used_at?: string | null
          nickname?: string | null
          player_id?: string
          public_key?: string
          transports?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "passkey_credentials_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      permission_baselines: {
        Row: {
          builtin_role: string | null
          capabilities: string[]
          created_at: string
          created_by: string | null
          id: string
          name: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          builtin_role?: string | null
          capabilities: string[]
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          builtin_role?: string | null
          capabilities?: string[]
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "permission_baselines_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "permission_baselines_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_settings: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "platform_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      player_discord_links: {
        Row: {
          discord_user_id: string
          last_synced_at: string | null
          linked_at: string
          player_id: string
        }
        Insert: {
          discord_user_id: string
          last_synced_at?: string | null
          linked_at?: string
          player_id: string
        }
        Update: {
          discord_user_id?: string
          last_synced_at?: string | null
          linked_at?: string
          player_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_discord_links_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          active_flag: boolean
          avatar_url: string | null
          ban_reason: string | null
          banned_at: string | null
          banned_by: string | null
          bio: string | null
          competition_category: string | null
          created_at: string
          deletion_requested_at: string | null
          display_name: string | null
          eligibility_flag: boolean
          elo_review: Json | null
          email: string
          exec_bio: string | null
          exec_hidden: boolean
          exec_photo_url: string | null
          exec_title: string | null
          fee_exempt: boolean
          first_name: string
          full_name: string
          handle: string | null
          hide_from_leaderboard: boolean
          id: string
          inactive_since: string | null
          inactivity_notice_sent_at: string | null
          is_banned: boolean
          is_exec: boolean
          is_trainer: boolean
          joined_at: string
          last_active_at: string
          last_name: string | null
          media_consent: boolean
          media_consent_changed_at: string | null
          member_code: string | null
          membership_type: Database["public"]["Enums"]["membership_type"]
          notification_preferences: Json
          onboarding_completed: boolean
          passkey_setup: string | null
          permission_baseline_id: string | null
          permission_grants: string[]
          permission_revokes: string[]
          permission_role: string | null
          phone: string | null
          privilege_claim_review: Json | null
          profile_visibility: string
          role: Database["public"]["Enums"]["user_role"]
          show_activity_status: boolean
          skill_tier: string | null
          status: Database["public"]["Enums"]["player_status"]
          tours_seen: Json
          updated_at: string
          user_id: string | null
          waiver_reset_at: string | null
        }
        Insert: {
          active_flag?: boolean
          avatar_url?: string | null
          ban_reason?: string | null
          banned_at?: string | null
          banned_by?: string | null
          bio?: string | null
          competition_category?: string | null
          created_at?: string
          deletion_requested_at?: string | null
          display_name?: string | null
          eligibility_flag?: boolean
          elo_review?: Json | null
          email: string
          exec_bio?: string | null
          exec_hidden?: boolean
          exec_photo_url?: string | null
          exec_title?: string | null
          fee_exempt?: boolean
          first_name: string
          full_name?: string
          handle?: string | null
          hide_from_leaderboard?: boolean
          id?: string
          inactive_since?: string | null
          inactivity_notice_sent_at?: string | null
          is_banned?: boolean
          is_exec?: boolean
          is_trainer?: boolean
          joined_at?: string
          last_active_at?: string
          last_name?: string | null
          media_consent?: boolean
          media_consent_changed_at?: string | null
          member_code?: string | null
          membership_type?: Database["public"]["Enums"]["membership_type"]
          notification_preferences?: Json
          onboarding_completed?: boolean
          passkey_setup?: string | null
          permission_baseline_id?: string | null
          permission_grants?: string[]
          permission_revokes?: string[]
          permission_role?: string | null
          phone?: string | null
          privilege_claim_review?: Json | null
          profile_visibility?: string
          role?: Database["public"]["Enums"]["user_role"]
          show_activity_status?: boolean
          skill_tier?: string | null
          status?: Database["public"]["Enums"]["player_status"]
          tours_seen?: Json
          updated_at?: string
          user_id?: string | null
          waiver_reset_at?: string | null
        }
        Update: {
          active_flag?: boolean
          avatar_url?: string | null
          ban_reason?: string | null
          banned_at?: string | null
          banned_by?: string | null
          bio?: string | null
          competition_category?: string | null
          created_at?: string
          deletion_requested_at?: string | null
          display_name?: string | null
          eligibility_flag?: boolean
          elo_review?: Json | null
          email?: string
          exec_bio?: string | null
          exec_hidden?: boolean
          exec_photo_url?: string | null
          exec_title?: string | null
          fee_exempt?: boolean
          first_name?: string
          full_name?: string
          handle?: string | null
          hide_from_leaderboard?: boolean
          id?: string
          inactive_since?: string | null
          inactivity_notice_sent_at?: string | null
          is_banned?: boolean
          is_exec?: boolean
          is_trainer?: boolean
          joined_at?: string
          last_active_at?: string
          last_name?: string | null
          media_consent?: boolean
          media_consent_changed_at?: string | null
          member_code?: string | null
          membership_type?: Database["public"]["Enums"]["membership_type"]
          notification_preferences?: Json
          onboarding_completed?: boolean
          passkey_setup?: string | null
          permission_baseline_id?: string | null
          permission_grants?: string[]
          permission_revokes?: string[]
          permission_role?: string | null
          phone?: string | null
          privilege_claim_review?: Json | null
          profile_visibility?: string
          role?: Database["public"]["Enums"]["user_role"]
          show_activity_status?: boolean
          skill_tier?: string | null
          status?: Database["public"]["Enums"]["player_status"]
          tours_seen?: Json
          updated_at?: string
          user_id?: string | null
          waiver_reset_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "players_banned_by_fkey"
            columns: ["banned_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "players_permission_baseline_id_fkey"
            columns: ["permission_baseline_id"]
            isOneToOne: false
            referencedRelation: "permission_baselines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "players_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          active: boolean
          auth_key: string
          created_at: string
          endpoint: string
          id: string
          p256dh_key: string
          player_id: string
          user_agent: string | null
        }
        Insert: {
          active?: boolean
          auth_key: string
          created_at?: string
          endpoint: string
          id?: string
          p256dh_key: string
          player_id: string
          user_agent?: string | null
        }
        Update: {
          active?: boolean
          auth_key?: string
          created_at?: string
          endpoint?: string
          id?: string
          p256dh_key?: string
          player_id?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      ratings: {
        Row: {
          best_doubles_streak: number
          best_singles_streak: number
          created_at: string
          current_doubles_streak: number
          current_singles_streak: number
          doubles_elo: number
          doubles_games_lost: number
          doubles_games_won: number
          doubles_k_factor: number
          doubles_losses: number
          doubles_matches_played: number
          doubles_points_allowed: number
          doubles_points_scored: number
          doubles_provisional: boolean
          doubles_wins: number
          id: string
          player_id: string
          singles_elo: number
          singles_games_lost: number
          singles_games_won: number
          singles_k_factor: number
          singles_losses: number
          singles_matches_played: number
          singles_points_allowed: number
          singles_points_scored: number
          singles_provisional: boolean
          singles_wins: number
          updated_at: string
        }
        Insert: {
          best_doubles_streak?: number
          best_singles_streak?: number
          created_at?: string
          current_doubles_streak?: number
          current_singles_streak?: number
          doubles_elo?: number
          doubles_games_lost?: number
          doubles_games_won?: number
          doubles_k_factor?: number
          doubles_losses?: number
          doubles_matches_played?: number
          doubles_points_allowed?: number
          doubles_points_scored?: number
          doubles_provisional?: boolean
          doubles_wins?: number
          id?: string
          player_id: string
          singles_elo?: number
          singles_games_lost?: number
          singles_games_won?: number
          singles_k_factor?: number
          singles_losses?: number
          singles_matches_played?: number
          singles_points_allowed?: number
          singles_points_scored?: number
          singles_provisional?: boolean
          singles_wins?: number
          updated_at?: string
        }
        Update: {
          best_doubles_streak?: number
          best_singles_streak?: number
          created_at?: string
          current_doubles_streak?: number
          current_singles_streak?: number
          doubles_elo?: number
          doubles_games_lost?: number
          doubles_games_won?: number
          doubles_k_factor?: number
          doubles_losses?: number
          doubles_matches_played?: number
          doubles_points_allowed?: number
          doubles_points_scored?: number
          doubles_provisional?: boolean
          doubles_wins?: number
          id?: string
          player_id?: string
          singles_elo?: number
          singles_games_lost?: number
          singles_games_won?: number
          singles_k_factor?: number
          singles_losses?: number
          singles_matches_played?: number
          singles_points_allowed?: number
          singles_points_scored?: number
          singles_provisional?: boolean
          singles_wins?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ratings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      reliability_metrics: {
        Row: {
          avg_confirmation_minutes: number
          challenges_accepted: number
          challenges_expired: number
          challenges_issued: number
          challenges_rejected: number
          dispute_involvement_count: number
          early_withdrawals: number
          id: string
          late_cancellations: number
          matches_completed: number
          no_shows: number
          player_id: string
          updated_at: string
          walkover_flag: boolean
          walkovers_received: number
        }
        Insert: {
          avg_confirmation_minutes?: number
          challenges_accepted?: number
          challenges_expired?: number
          challenges_issued?: number
          challenges_rejected?: number
          dispute_involvement_count?: number
          early_withdrawals?: number
          id?: string
          late_cancellations?: number
          matches_completed?: number
          no_shows?: number
          player_id: string
          updated_at?: string
          walkover_flag?: boolean
          walkovers_received?: number
        }
        Update: {
          avg_confirmation_minutes?: number
          challenges_accepted?: number
          challenges_expired?: number
          challenges_issued?: number
          challenges_rejected?: number
          dispute_involvement_count?: number
          early_withdrawals?: number
          id?: string
          late_cancellations?: number
          matches_completed?: number
          no_shows?: number
          player_id?: string
          updated_at?: string
          walkover_flag?: boolean
          walkovers_received?: number
        }
        Relationships: [
          {
            foreignKeyName: "reliability_metrics_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      schema_migrations: {
        Row: {
          applied_at: string
          applied_by: string
          checksum: string
          name: string
          verified: boolean
          version: string
        }
        Insert: {
          applied_at?: string
          applied_by: string
          checksum: string
          name: string
          verified?: boolean
          version: string
        }
        Update: {
          applied_at?: string
          applied_by?: string
          checksum?: string
          name?: string
          verified?: boolean
          version?: string
        }
        Relationships: []
      }
      season_final_ratings: {
        Row: {
          archived_at: string
          doubles_elo: number
          id: string
          player_id: string
          season_id: string
          singles_elo: number
        }
        Insert: {
          archived_at?: string
          doubles_elo: number
          id?: string
          player_id: string
          season_id: string
          singles_elo: number
        }
        Update: {
          archived_at?: string
          doubles_elo?: number
          id?: string
          player_id?: string
          season_id?: string
          singles_elo?: number
        }
        Relationships: [
          {
            foreignKeyName: "season_final_ratings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "season_final_ratings_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      seasons: {
        Row: {
          active_flag: boolean
          competitive_fee_cents: number
          created_at: string
          end_date: string | null
          hidden_flag: boolean
          id: string
          name: string
          recreational_fee_cents: number
          start_date: string
          term: Database["public"]["Enums"]["season_term"]
          updated_at: string
          year: number
        }
        Insert: {
          active_flag?: boolean
          competitive_fee_cents?: number
          created_at?: string
          end_date?: string | null
          hidden_flag?: boolean
          id?: string
          name: string
          recreational_fee_cents?: number
          start_date: string
          term: Database["public"]["Enums"]["season_term"]
          updated_at?: string
          year: number
        }
        Update: {
          active_flag?: boolean
          competitive_fee_cents?: number
          created_at?: string
          end_date?: string | null
          hidden_flag?: boolean
          id?: string
          name?: string
          recreational_fee_cents?: number
          start_date?: string
          term?: Database["public"]["Enums"]["season_term"]
          updated_at?: string
          year?: number
        }
        Relationships: []
      }
      session_attendance: {
        Row: {
          checked_in_at: string
          id: string
          marked_at: string | null
          marked_by: string | null
          player_id: string
          session_id: string
          status: Database["public"]["Enums"]["attendance_status"]
        }
        Insert: {
          checked_in_at?: string
          id?: string
          marked_at?: string | null
          marked_by?: string | null
          player_id: string
          session_id: string
          status?: Database["public"]["Enums"]["attendance_status"]
        }
        Update: {
          checked_in_at?: string
          id?: string
          marked_at?: string | null
          marked_by?: string | null
          player_id?: string
          session_id?: string
          status?: Database["public"]["Enums"]["attendance_status"]
        }
        Relationships: [
          {
            foreignKeyName: "session_attendance_marked_by_fkey"
            columns: ["marked_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_attendance_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_attendance_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_checkin_tokens: {
        Row: {
          created_at: string
          rotated_at: string | null
          session_id: string
          token: string
        }
        Insert: {
          created_at?: string
          rotated_at?: string | null
          session_id: string
          token: string
        }
        Update: {
          created_at?: string
          rotated_at?: string | null
          session_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_checkin_tokens_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: true
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      session_rsvp: {
        Row: {
          created_at: string
          id: string
          intent: Database["public"]["Enums"]["session_intent"]
          player_id: string
          reminded_at: string | null
          reminder_attempted_at: string | null
          reminder_attempts: number
          reminder_failed_at: string | null
          session_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          intent: Database["public"]["Enums"]["session_intent"]
          player_id: string
          reminded_at?: string | null
          reminder_attempted_at?: string | null
          reminder_attempts?: number
          reminder_failed_at?: string | null
          session_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          intent?: Database["public"]["Enums"]["session_intent"]
          player_id?: string
          reminded_at?: string | null
          reminder_attempted_at?: string | null
          reminder_attempts?: number
          reminder_failed_at?: string | null
          session_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_rsvp_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_rsvp_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          created_at: string
          date: string
          end_time: string | null
          ends_at: string | null
          host_player_id: string | null
          id: string
          location: string
          name: string | null
          notes: string | null
          reminder_sent_at: string | null
          require_scan_to_check_in: boolean
          season_id: string | null
          start_time: string | null
          starts_at: string | null
          status: Database["public"]["Enums"]["session_status"]
          track: Database["public"]["Enums"]["session_group"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          date: string
          end_time?: string | null
          ends_at?: string | null
          host_player_id?: string | null
          id?: string
          location: string
          name?: string | null
          notes?: string | null
          reminder_sent_at?: string | null
          require_scan_to_check_in?: boolean
          season_id?: string | null
          start_time?: string | null
          starts_at?: string | null
          status?: Database["public"]["Enums"]["session_status"]
          track?: Database["public"]["Enums"]["session_group"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          date?: string
          end_time?: string | null
          ends_at?: string | null
          host_player_id?: string | null
          id?: string
          location?: string
          name?: string | null
          notes?: string | null
          reminder_sent_at?: string | null
          require_scan_to_check_in?: boolean
          season_id?: string | null
          start_time?: string | null
          starts_at?: string | null
          status?: Database["public"]["Enums"]["session_status"]
          track?: Database["public"]["Enums"]["session_group"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_host_player_id_fkey"
            columns: ["host_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_audit_log: {
        Row: {
          action: string
          created_at: string | null
          details: Json | null
          event_id: string | null
          id: string
          match_id: string | null
          performed_by: string | null
          tournament_id: string | null
        }
        Insert: {
          action: string
          created_at?: string | null
          details?: Json | null
          event_id?: string | null
          id?: string
          match_id?: string | null
          performed_by?: string | null
          tournament_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string | null
          details?: Json | null
          event_id?: string | null
          id?: string
          match_id?: string | null
          performed_by?: string | null
          tournament_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tournament_audit_log_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_audit_log_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "tournament_matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_audit_log_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_audit_log_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_bonus_grants: {
        Row: {
          applied_delta: number
          discipline: string | null
          event_id: string
          granted_at: string
          id: string
          kind: string
          requested_bonus: number
          subject_id: string
        }
        Insert: {
          applied_delta?: number
          discipline?: string | null
          event_id: string
          granted_at?: string
          id?: string
          kind: string
          requested_bonus: number
          subject_id: string
        }
        Update: {
          applied_delta?: number
          discipline?: string | null
          event_id?: string
          granted_at?: string
          id?: string
          kind?: string
          requested_bonus?: number
          subject_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_bonus_grants_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_category_requests: {
        Row: {
          event_id: string
          from_category: string | null
          id: string
          pair_id: string
          reason: string
          requested_at: string
          requested_by: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          to_category: string | null
        }
        Insert: {
          event_id: string
          from_category?: string | null
          id?: string
          pair_id: string
          reason: string
          requested_at?: string
          requested_by?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          to_category?: string | null
        }
        Update: {
          event_id?: string
          from_category?: string | null
          id?: string
          pair_id?: string
          reason?: string
          requested_at?: string
          requested_by?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          to_category?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tournament_category_requests_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_category_requests_pair_id_fkey"
            columns: ["pair_id"]
            isOneToOne: false
            referencedRelation: "tournament_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_category_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_category_requests_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_checkin_tokens: {
        Row: {
          created_at: string
          rotated_at: string | null
          token: string
          tournament_id: string
        }
        Insert: {
          created_at?: string
          rotated_at?: string | null
          token: string
          tournament_id: string
        }
        Update: {
          created_at?: string
          rotated_at?: string | null
          token?: string
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_checkin_tokens_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: true
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_courts: {
        Row: {
          active: boolean
          created_at: string
          id: string
          label: string
          notes: string | null
          sort_order: number
          tournament_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          label: string
          notes?: string | null
          sort_order?: number
          tournament_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          label?: string
          notes?: string | null
          sort_order?: number
          tournament_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_courts_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_event_waitlist: {
        Row: {
          event_id: string
          id: string
          joined_at: string
          player_id: string
          promoted_participant_id: string | null
          reason: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
        }
        Insert: {
          event_id: string
          id?: string
          joined_at?: string
          player_id: string
          promoted_participant_id?: string | null
          reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Update: {
          event_id?: string
          id?: string
          joined_at?: string
          player_id?: string
          promoted_participant_id?: string | null
          reason?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_event_waitlist_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_event_waitlist_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_event_waitlist_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_events: {
        Row: {
          checkin_closes_at: string | null
          checkin_opens_at: string | null
          created_at: string | null
          current_stage: number | null
          draw_generation_id: string | null
          draw_locked: boolean | null
          elo_multiplier: number | null
          event_type: string
          external_event: boolean
          format: string
          format_config: Json | null
          games_per_match: number | null
          group_count: number | null
          id: string
          match_format: string
          max_participants: number | null
          placement_bonus_enabled: boolean | null
          points_config: Json | null
          points_per_game: number | null
          qualifiers_per_group: number | null
          rated: boolean
          registration_closes_at: string | null
          registration_opens_at: string | null
          seed_by: string | null
          seed_skip_count: number
          seeded_from_event_id: string | null
          seeding_method: string
          status: string
          tournament_id: string
          updated_at: string | null
          waitlist_auto_promote: boolean
          waitlist_enabled: boolean
        }
        Insert: {
          checkin_closes_at?: string | null
          checkin_opens_at?: string | null
          created_at?: string | null
          current_stage?: number | null
          draw_generation_id?: string | null
          draw_locked?: boolean | null
          elo_multiplier?: number | null
          event_type: string
          external_event?: boolean
          format: string
          format_config?: Json | null
          games_per_match?: number | null
          group_count?: number | null
          id?: string
          match_format?: string
          max_participants?: number | null
          placement_bonus_enabled?: boolean | null
          points_config?: Json | null
          points_per_game?: number | null
          qualifiers_per_group?: number | null
          rated?: boolean
          registration_closes_at?: string | null
          registration_opens_at?: string | null
          seed_by?: string | null
          seed_skip_count?: number
          seeded_from_event_id?: string | null
          seeding_method?: string
          status?: string
          tournament_id: string
          updated_at?: string | null
          waitlist_auto_promote?: boolean
          waitlist_enabled?: boolean
        }
        Update: {
          checkin_closes_at?: string | null
          checkin_opens_at?: string | null
          created_at?: string | null
          current_stage?: number | null
          draw_generation_id?: string | null
          draw_locked?: boolean | null
          elo_multiplier?: number | null
          event_type?: string
          external_event?: boolean
          format?: string
          format_config?: Json | null
          games_per_match?: number | null
          group_count?: number | null
          id?: string
          match_format?: string
          max_participants?: number | null
          placement_bonus_enabled?: boolean | null
          points_config?: Json | null
          points_per_game?: number | null
          qualifiers_per_group?: number | null
          rated?: boolean
          registration_closes_at?: string | null
          registration_opens_at?: string | null
          seed_by?: string | null
          seed_skip_count?: number
          seeded_from_event_id?: string | null
          seeding_method?: string
          status?: string
          tournament_id?: string
          updated_at?: string | null
          waitlist_auto_promote?: boolean
          waitlist_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "tournament_events_seeded_from_event_id_fkey"
            columns: ["seeded_from_event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_events_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_fee_tiers: {
        Row: {
          amount_cents: number
          applies_to: Database["public"]["Enums"]["membership_type"][] | null
          created_at: string
          id: string
          is_default: boolean
          name: string
          sort_order: number
          tournament_id: string
        }
        Insert: {
          amount_cents: number
          applies_to?: Database["public"]["Enums"]["membership_type"][] | null
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          sort_order?: number
          tournament_id: string
        }
        Update: {
          amount_cents?: number
          applies_to?: Database["public"]["Enums"]["membership_type"][] | null
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          sort_order?: number
          tournament_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_fee_tiers_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_match_notes: {
        Row: {
          author_id: string | null
          created_at: string
          match_id: string
          note: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          match_id: string
          note: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          match_id?: string
          note?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_match_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_match_notes_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: true
            referencedRelation: "tournament_matches"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_matches: {
        Row: {
          bracket_position: number
          court: string | null
          court_id: string | null
          created_at: string | null
          draw_generation_id: string | null
          elo_snapshot: Json | null
          event_id: string
          games_per_match: number | null
          group_number: number | null
          handicap_a: number
          handicap_b: number
          id: string
          is_bye: boolean | null
          is_third_place: boolean
          loser_pair_id: string | null
          loser_participant_id: string | null
          loser_to_match_id: string | null
          loser_to_position: string | null
          match_format: string | null
          match_label: string | null
          match_number: number | null
          pair_a_id: string | null
          pair_b_id: string | null
          participant_a_id: string | null
          participant_b_id: string | null
          phase: string | null
          points_per_game: number | null
          pool_number: number | null
          ready_player_ids: string[]
          result_entered_at: string | null
          result_entered_by: string | null
          round_name: string | null
          round_number: number
          scheduled_time: string | null
          scores: Json | null
          slot: number | null
          stage: number | null
          status: string
          time_exceeded: boolean
          updated_at: string | null
          walkover_reason: string | null
          walkover_winner: string | null
          winner_pair_id: string | null
          winner_participant_id: string | null
          winner_to_match_id: string | null
          winner_to_position: string | null
        }
        Insert: {
          bracket_position: number
          court?: string | null
          court_id?: string | null
          created_at?: string | null
          draw_generation_id?: string | null
          elo_snapshot?: Json | null
          event_id: string
          games_per_match?: number | null
          group_number?: number | null
          handicap_a?: number
          handicap_b?: number
          id?: string
          is_bye?: boolean | null
          is_third_place?: boolean
          loser_pair_id?: string | null
          loser_participant_id?: string | null
          loser_to_match_id?: string | null
          loser_to_position?: string | null
          match_format?: string | null
          match_label?: string | null
          match_number?: number | null
          pair_a_id?: string | null
          pair_b_id?: string | null
          participant_a_id?: string | null
          participant_b_id?: string | null
          phase?: string | null
          points_per_game?: number | null
          pool_number?: number | null
          ready_player_ids?: string[]
          result_entered_at?: string | null
          result_entered_by?: string | null
          round_name?: string | null
          round_number: number
          scheduled_time?: string | null
          scores?: Json | null
          slot?: number | null
          stage?: number | null
          status?: string
          time_exceeded?: boolean
          updated_at?: string | null
          walkover_reason?: string | null
          walkover_winner?: string | null
          winner_pair_id?: string | null
          winner_participant_id?: string | null
          winner_to_match_id?: string | null
          winner_to_position?: string | null
        }
        Update: {
          bracket_position?: number
          court?: string | null
          court_id?: string | null
          created_at?: string | null
          draw_generation_id?: string | null
          elo_snapshot?: Json | null
          event_id?: string
          games_per_match?: number | null
          group_number?: number | null
          handicap_a?: number
          handicap_b?: number
          id?: string
          is_bye?: boolean | null
          is_third_place?: boolean
          loser_pair_id?: string | null
          loser_participant_id?: string | null
          loser_to_match_id?: string | null
          loser_to_position?: string | null
          match_format?: string | null
          match_label?: string | null
          match_number?: number | null
          pair_a_id?: string | null
          pair_b_id?: string | null
          participant_a_id?: string | null
          participant_b_id?: string | null
          phase?: string | null
          points_per_game?: number | null
          pool_number?: number | null
          ready_player_ids?: string[]
          result_entered_at?: string | null
          result_entered_by?: string | null
          round_name?: string | null
          round_number?: number
          scheduled_time?: string | null
          scores?: Json | null
          slot?: number | null
          stage?: number | null
          status?: string
          time_exceeded?: boolean
          updated_at?: string | null
          walkover_reason?: string | null
          walkover_winner?: string | null
          winner_pair_id?: string | null
          winner_participant_id?: string | null
          winner_to_match_id?: string | null
          winner_to_position?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tournament_matches_court_id_fkey"
            columns: ["court_id"]
            isOneToOne: false
            referencedRelation: "tournament_courts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_loser_pair_id_fkey"
            columns: ["loser_pair_id"]
            isOneToOne: false
            referencedRelation: "tournament_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_loser_participant_id_fkey"
            columns: ["loser_participant_id"]
            isOneToOne: false
            referencedRelation: "tournament_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_loser_to_match_id_fkey"
            columns: ["loser_to_match_id"]
            isOneToOne: false
            referencedRelation: "tournament_matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_pair_a_id_fkey"
            columns: ["pair_a_id"]
            isOneToOne: false
            referencedRelation: "tournament_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_pair_b_id_fkey"
            columns: ["pair_b_id"]
            isOneToOne: false
            referencedRelation: "tournament_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_participant_a_id_fkey"
            columns: ["participant_a_id"]
            isOneToOne: false
            referencedRelation: "tournament_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_participant_b_id_fkey"
            columns: ["participant_b_id"]
            isOneToOne: false
            referencedRelation: "tournament_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_result_entered_by_fkey"
            columns: ["result_entered_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_winner_pair_id_fkey"
            columns: ["winner_pair_id"]
            isOneToOne: false
            referencedRelation: "tournament_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_winner_participant_id_fkey"
            columns: ["winner_participant_id"]
            isOneToOne: false
            referencedRelation: "tournament_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_winner_to_match_id_fkey"
            columns: ["winner_to_match_id"]
            isOneToOne: false
            referencedRelation: "tournament_matches"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_pair_notes: {
        Row: {
          author_id: string | null
          created_at: string
          note: string
          pair_id: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          note: string
          pair_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          note?: string
          pair_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_pair_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_pair_notes_pair_id_fkey"
            columns: ["pair_id"]
            isOneToOne: true
            referencedRelation: "tournament_pairs"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_pairs: {
        Row: {
          added_by: string | null
          checked_in_at: string | null
          checked_in_by: string | null
          combined_elo: number | null
          created_at: string | null
          event_id: string
          external1_name: string | null
          external2_name: string | null
          final_position: number | null
          group_number: number | null
          id: string
          pair_name: string | null
          player1_id: string | null
          player2_id: string | null
          points: number | null
          seed_number: number | null
          status: string
          team_category: string | null
        }
        Insert: {
          added_by?: string | null
          checked_in_at?: string | null
          checked_in_by?: string | null
          combined_elo?: number | null
          created_at?: string | null
          event_id: string
          external1_name?: string | null
          external2_name?: string | null
          final_position?: number | null
          group_number?: number | null
          id?: string
          pair_name?: string | null
          player1_id?: string | null
          player2_id?: string | null
          points?: number | null
          seed_number?: number | null
          status?: string
          team_category?: string | null
        }
        Update: {
          added_by?: string | null
          checked_in_at?: string | null
          checked_in_by?: string | null
          combined_elo?: number | null
          created_at?: string | null
          event_id?: string
          external1_name?: string | null
          external2_name?: string | null
          final_position?: number | null
          group_number?: number | null
          id?: string
          pair_name?: string | null
          player1_id?: string | null
          player2_id?: string | null
          points?: number | null
          seed_number?: number | null
          status?: string
          team_category?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tournament_pairs_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_pairs_checked_in_by_fkey"
            columns: ["checked_in_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_pairs_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_pairs_player1_id_fkey"
            columns: ["player1_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_pairs_player2_id_fkey"
            columns: ["player2_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_participant_notes: {
        Row: {
          author_id: string | null
          created_at: string
          note: string
          participant_id: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          note: string
          participant_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          note?: string
          participant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_participant_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_participant_notes_participant_id_fkey"
            columns: ["participant_id"]
            isOneToOne: true
            referencedRelation: "tournament_participants"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_participants: {
        Row: {
          added_by: string | null
          checked_in_at: string | null
          checked_in_by: string | null
          created_at: string | null
          elo_after: number | null
          elo_before: number | null
          elo_change: number | null
          event_id: string
          final_position: number | null
          group_number: number | null
          id: string
          player_id: string
          points: number | null
          seed_number: number | null
          status: string
        }
        Insert: {
          added_by?: string | null
          checked_in_at?: string | null
          checked_in_by?: string | null
          created_at?: string | null
          elo_after?: number | null
          elo_before?: number | null
          elo_change?: number | null
          event_id: string
          final_position?: number | null
          group_number?: number | null
          id?: string
          player_id: string
          points?: number | null
          seed_number?: number | null
          status?: string
        }
        Update: {
          added_by?: string | null
          checked_in_at?: string | null
          checked_in_by?: string | null
          created_at?: string | null
          elo_after?: number | null
          elo_before?: number | null
          elo_change?: number | null
          event_id?: string
          final_position?: number | null
          group_number?: number | null
          id?: string
          player_id?: string
          points?: number | null
          seed_number?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_participants_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_participants_checked_in_by_fkey"
            columns: ["checked_in_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_participants_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_participants_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      tournaments: {
        Row: {
          allowed_memberships: Database["public"]["Enums"]["membership_type"][]
          checkin_closes_at: string | null
          checkin_opens_at: string | null
          created_at: string
          created_by: string | null
          end_date: string | null
          event_multiplier: number
          id: string
          max_events_per_player: number | null
          name: string
          placement_bonus_amounts: Json | null
          placement_bonus_enabled: boolean
          registration_closes_at: string | null
          registration_opens_at: string | null
          season_id: string | null
          start_date: string
          status: Database["public"]["Enums"]["tournament_status"]
          suspended_at: string | null
          suspension_reason: string | null
          updated_at: string
          waiver_text: string | null
        }
        Insert: {
          allowed_memberships?: Database["public"]["Enums"]["membership_type"][]
          checkin_closes_at?: string | null
          checkin_opens_at?: string | null
          created_at?: string
          created_by?: string | null
          end_date?: string | null
          event_multiplier?: number
          id?: string
          max_events_per_player?: number | null
          name: string
          placement_bonus_amounts?: Json | null
          placement_bonus_enabled?: boolean
          registration_closes_at?: string | null
          registration_opens_at?: string | null
          season_id?: string | null
          start_date: string
          status?: Database["public"]["Enums"]["tournament_status"]
          suspended_at?: string | null
          suspension_reason?: string | null
          updated_at?: string
          waiver_text?: string | null
        }
        Update: {
          allowed_memberships?: Database["public"]["Enums"]["membership_type"][]
          checkin_closes_at?: string | null
          checkin_opens_at?: string | null
          created_at?: string
          created_by?: string | null
          end_date?: string | null
          event_multiplier?: number
          id?: string
          max_events_per_player?: number | null
          name?: string
          placement_bonus_amounts?: Json | null
          placement_bonus_enabled?: boolean
          registration_closes_at?: string | null
          registration_opens_at?: string | null
          season_id?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["tournament_status"]
          suspended_at?: string | null
          suspension_reason?: string | null
          updated_at?: string
          waiver_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tournaments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournaments_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      varsity_notes: {
        Row: {
          author_id: string
          created_at: string
          id: string
          note: string
          player_id: string
          updated_at: string
        }
        Insert: {
          author_id: string
          created_at?: string
          id?: string
          note: string
          player_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          created_at?: string
          id?: string
          note?: string
          player_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "varsity_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "varsity_notes_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      waiver_acceptances: {
        Row: {
          accepted_at: string
          age_attestation: boolean
          document: string
          id: string
          player_id: string
          user_agent: string | null
          version: string
        }
        Insert: {
          accepted_at?: string
          age_attestation?: boolean
          document: string
          id?: string
          player_id: string
          user_agent?: string | null
          version: string
        }
        Update: {
          accepted_at?: string
          age_attestation?: boolean
          document?: string
          id?: string
          player_id?: string
          user_agent?: string | null
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiver_acceptances_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      walkover_admin_notes: {
        Row: {
          author_id: string | null
          created_at: string
          note: string
          updated_at: string
          walkover_id: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          note: string
          updated_at?: string
          walkover_id: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          note?: string
          updated_at?: string
          walkover_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "walkover_admin_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "walkover_admin_notes_walkover_id_fkey"
            columns: ["walkover_id"]
            isOneToOne: true
            referencedRelation: "walkovers"
            referencedColumns: ["id"]
          },
        ]
      }
      walkovers: {
        Row: {
          admin_confirmed_at: string | null
          admin_confirmed_by: string | null
          challenge_id: string
          created_at: string
          elo_penalty_applied: boolean
          forfeit_player_id: string
          grace_period_ends_at: string | null
          id: string
          match_id: string | null
          notice_hours: number | null
          reported_at: string
          reported_by: string
          status: Database["public"]["Enums"]["walkover_status"]
          updated_at: string
          walkover_type: Database["public"]["Enums"]["walkover_type"]
        }
        Insert: {
          admin_confirmed_at?: string | null
          admin_confirmed_by?: string | null
          challenge_id: string
          created_at?: string
          elo_penalty_applied?: boolean
          forfeit_player_id: string
          grace_period_ends_at?: string | null
          id?: string
          match_id?: string | null
          notice_hours?: number | null
          reported_at?: string
          reported_by: string
          status?: Database["public"]["Enums"]["walkover_status"]
          updated_at?: string
          walkover_type: Database["public"]["Enums"]["walkover_type"]
        }
        Update: {
          admin_confirmed_at?: string | null
          admin_confirmed_by?: string | null
          challenge_id?: string
          created_at?: string
          elo_penalty_applied?: boolean
          forfeit_player_id?: string
          grace_period_ends_at?: string | null
          id?: string
          match_id?: string | null
          notice_hours?: number | null
          reported_at?: string
          reported_by?: string
          status?: Database["public"]["Enums"]["walkover_status"]
          updated_at?: string
          walkover_type?: Database["public"]["Enums"]["walkover_type"]
        }
        Relationships: [
          {
            foreignKeyName: "walkovers_admin_confirmed_by_fkey"
            columns: ["admin_confirmed_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "walkovers_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "walkovers_forfeit_player_id_fkey"
            columns: ["forfeit_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "walkovers_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "walkovers_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      players_self: {
        Row: {
          active_flag: boolean | null
          avatar_url: string | null
          ban_reason: string | null
          banned_at: string | null
          banned_by: string | null
          bio: string | null
          created_at: string | null
          deletion_requested_at: string | null
          display_name: string | null
          eligibility_flag: boolean | null
          email: string | null
          exec_title: string | null
          fee_exempt: boolean | null
          first_name: string | null
          full_name: string | null
          hide_from_leaderboard: boolean | null
          id: string | null
          is_banned: boolean | null
          is_exec: boolean | null
          joined_at: string | null
          last_active_at: string | null
          last_name: string | null
          notification_preferences: Json | null
          onboarding_completed: boolean | null
          phone: string | null
          profile_visibility: string | null
          role: Database["public"]["Enums"]["user_role"] | null
          show_activity_status: boolean | null
          status: Database["public"]["Enums"]["player_status"] | null
          updated_at: string | null
          user_id: string | null
          waiver_reset_at: string | null
        }
        Insert: {
          active_flag?: boolean | null
          avatar_url?: string | null
          ban_reason?: string | null
          banned_at?: string | null
          banned_by?: string | null
          bio?: string | null
          created_at?: string | null
          deletion_requested_at?: string | null
          display_name?: string | null
          eligibility_flag?: boolean | null
          email?: string | null
          exec_title?: string | null
          fee_exempt?: boolean | null
          first_name?: string | null
          full_name?: string | null
          hide_from_leaderboard?: boolean | null
          id?: string | null
          is_banned?: boolean | null
          is_exec?: boolean | null
          joined_at?: string | null
          last_active_at?: string | null
          last_name?: string | null
          notification_preferences?: Json | null
          onboarding_completed?: boolean | null
          phone?: string | null
          profile_visibility?: string | null
          role?: Database["public"]["Enums"]["user_role"] | null
          show_activity_status?: boolean | null
          status?: Database["public"]["Enums"]["player_status"] | null
          updated_at?: string | null
          user_id?: string | null
          waiver_reset_at?: string | null
        }
        Update: {
          active_flag?: boolean | null
          avatar_url?: string | null
          ban_reason?: string | null
          banned_at?: string | null
          banned_by?: string | null
          bio?: string | null
          created_at?: string | null
          deletion_requested_at?: string | null
          display_name?: string | null
          eligibility_flag?: boolean | null
          email?: string | null
          exec_title?: string | null
          fee_exempt?: boolean | null
          first_name?: string | null
          full_name?: string | null
          hide_from_leaderboard?: boolean | null
          id?: string | null
          is_banned?: boolean | null
          is_exec?: boolean | null
          joined_at?: string | null
          last_active_at?: string | null
          last_name?: string | null
          notification_preferences?: Json | null
          onboarding_completed?: boolean | null
          phone?: string | null
          profile_visibility?: string | null
          role?: Database["public"]["Enums"]["user_role"] | null
          show_activity_status?: boolean | null
          status?: Database["public"]["Enums"]["player_status"] | null
          updated_at?: string | null
          user_id?: string | null
          waiver_reset_at?: string | null
        }
        Relationships: []
      }
      purgeable_inactive_players: {
        Row: {
          id: string | null
          inactive_since: string | null
          purge_after_days: number | null
          user_id: string | null
        }
        Insert: {
          id?: string | null
          inactive_since?: string | null
          purge_after_days?: number | null
          user_id?: string | null
        }
        Update: {
          id?: string | null
          inactive_since?: string | null
          purge_after_days?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      purgeable_unfinished_signups: {
        Row: {
          created_at: string | null
          id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      activate_season: {
        Args: {
          p_compression_factor?: number
          p_elo_policy?: string
          p_season_id: string
        }
        Returns: undefined
      }
      add_external_tournament_pair: {
        Args: {
          p_added_by: string
          p_event_id: string
          p_external1_name: string
          p_external2_name: string
          p_team_name?: string
        }
        Returns: string
      }
      add_external_tournament_pair_v2: {
        Args: {
          p_added_by: string
          p_category?: string
          p_event_id: string
          p_external1_name: string
          p_external2_name: string
          p_team_name?: string
        }
        Returns: string
      }
      add_participants_under_field_lock: {
        Args: { p_admin_id: string; p_entries: Json; p_event_id: string }
        Returns: Json
      }
      admin_access_level: { Args: { p_user_id: string }; Returns: string }
      admin_console_access: { Args: { p_user_id: string }; Returns: Json }
      admins_with_passkeys: {
        Args: { p_excluding_credential?: string; p_excluding_player?: string }
        Returns: number
      }
      apply_match_result: {
        Args: { p_confirmed_by: string; p_match_id: string }
        Returns: undefined
      }
      apply_placement_bonus: {
        Args: {
          p_bonus: number
          p_discipline: string
          p_event_id: string
          p_player_id: string
        }
        Returns: Json
      }
      apply_rating_delta: {
        Args: {
          p_delta: number
          p_discipline: string
          p_games_lost: number
          p_games_won: number
          p_player_id: string
          p_points_allowed: number
          p_points_scored: number
          p_won: boolean
        }
        Returns: Json
      }
      apply_skill_tier_seed: {
        Args: { p_player_id: string; p_tier: string }
        Returns: boolean
      }
      apply_tournament_match_rating: {
        Args: { p_discipline: string; p_entries: Json; p_match_id: string }
        Returns: undefined
      }
      apply_walkover_result: {
        Args: {
          p_admin_id: string
          p_admin_notes?: string
          p_walkover_id: string
        }
        Returns: undefined
      }
      approve_pair_category_request: {
        Args: { p_actor: string; p_request_id: string }
        Returns: Json
      }
      assert_notification_patch: {
        Args: { p_email_only?: boolean; p_patch: Json }
        Returns: undefined
      }
      assign_member_code: { Args: { p_player_id: string }; Returns: string }
      auto_rollover_season: { Args: Record<PropertyKey, never>; Returns: Json }
      auto_seed_field_by_rating: {
        Args: { p_event_id: string; p_is_pair: boolean }
        Returns: Json
      }
      boost_match_rating: {
        Args: {
          p_actor_id: string
          p_boost: number
          p_match_id: string
          p_reason: string
        }
        Returns: Json
      }
      bulk_check_in_field: {
        Args: {
          p_actor: string
          p_event_id: string
          p_ids: string[]
          p_is_pair: boolean
        }
        Returns: Json
      }
      calculate_elo_update: {
        Args: {
          p_event_multiplier: number
          p_format_weight: number
          p_k_factor: number
          p_margin_multiplier?: number
          p_opponent_rating: number
          p_player_rating: number
          p_won: boolean
        }
        Returns: { delta: number; expected: number; new_rating: number }[]
      }
      check_session_caps: {
        Args: {
          p_match_type: string
          p_player_id: string
          p_session_id: string
        }
        Returns: boolean
      }
      claim_dispute_for_resolution: {
        Args: {
          p_actor_id: string
          p_dispute_id: string
          p_resolution_type?: Database["public"]["Enums"]["dispute_resolution"]
        }
        Returns: Json
      }
      claim_privilege_attribution: {
        Args: { p_player_id: string }
        Returns: Json
      }
      claim_registration_form_polls: {
        Args: { p_limit: number; p_min_interval_seconds: number }
        Returns: {
          claimed_at: string
          club_event_id: string
          form_id: string
          id: string
          poll_watermark: string
          read_mapping: Json
          target_kind: string
          tournament_id: string
        }[]
      }
      claim_session_reminders: {
        Args: {
          p_max_attempts?: number
          p_player_ids: string[]
          p_session_id: string
          p_stale_before: string
        }
        Returns: { gave_up: boolean; player_id: string }[]
      }
      clear_field_seeds: {
        Args: { p_event_id: string; p_is_pair: boolean }
        Returns: Json
      }
      club_local_instant: {
        Args: { p_date: string; p_time: string }
        Returns: string
      }
      complete_event_under_field_lock: {
        Args: {
          p_clear: string[]
          p_event_id: string
          p_field: string[]
          p_is_pair: boolean
          p_points: Json
          p_positions: Json
          p_results: Json
          p_won: string[]
        }
        Returns: Json
      }
      console_passkey_grace_start: { Args: Record<PropertyKey, never>; Returns: Json }
      consume_discord_link_token: {
        Args: { p_token_hash: string }
        Returns: {
          displaced_discord_user_id: string
          linked_discord_user_id: string
        }[]
      }
      consume_passkey_challenge: {
        Args: { p_challenge_hash: string; p_purpose: string }
        Returns: boolean
      }
      convert_club_match_to_casual: {
        Args: { p_actor_id: string; p_match_id: string; p_reason: string }
        Returns: Json
      }
      create_challenge_atomic: {
        Args: {
          p_format: string
          p_games_per_match?: number
          p_note?: string
          p_opponent_id: string
          p_opponent_partner_id?: string
          p_partner_id?: string
          p_points_per_game?: number
          p_rated_flag: boolean
          p_scheduled_date?: string
          p_scheduled_time?: string
          p_session_id?: string
          p_type: string
        }
        Returns: Json
      }
      create_challenge_for: {
        Args: {
          p_creator: string
          p_format: string
          p_games_per_match?: number
          p_note?: string
          p_opponent_id: string
          p_opponent_partner_id?: string
          p_partner_id?: string
          p_points_per_game?: number
          p_rated_flag: boolean
          p_scheduled_date?: string
          p_scheduled_time?: string
          p_session_id?: string
          p_type: string
        }
        Returns: Json
      }
      create_player_with_rating: {
        Args: {
          p_display_name?: string
          p_email: string
          p_first_name: string
          p_last_name?: string
          p_phone?: string
          p_role?: Database["public"]["Enums"]["user_role"]
          p_status?: Database["public"]["Enums"]["player_status"]
          p_user_id: string
        }
        Returns: string
      }
      credit_participant_placement_bonus: {
        Args: { p_bonus: number; p_event_id: string; p_participant_id: string }
        Returns: Json
      }
      delete_phase_matches: {
        Args: { p_event_id: string; p_phase: string }
        Returns: Json
      }
      delete_stage_matches: {
        Args: { p_event_id: string; p_stage: number }
        Returns: Json
      }
      derive_member_code: { Args: { p_player_id: string }; Returns: string }
      derived_format_weight: {
        Args: { p_best_of: number; p_target: number }
        Returns: number
      }
      discord_role_is_member_chosen: {
        Args: { p_role_name: string }
        Returns: boolean
      }
      dispute_match_result: {
        Args: {
          p_description: string
          p_match_id: string
          p_reason_category: Database["public"]["Enums"]["dispute_reason"]
        }
        Returns: string
      }
      effective_best_of: {
        Args: {
          p_format: Database["public"]["Enums"]["match_format"]
          p_games: number
        }
        Returns: number
      }
      effective_target: {
        Args: {
          p_format: Database["public"]["Enums"]["match_format"]
          p_points: number
        }
        Returns: number
      }
      ensure_player_for_user: { Args: { p_user_id: string }; Returns: string }
      enter_tournament_event: {
        Args: {
          p_doubles: boolean
          p_elo_before: number
          p_event_id: string
          p_player_id: string
          p_user_agent?: string
          p_waiver_hash?: string
        }
        Returns: Json
      }
      entry_window_state: {
        Args: { p_closes: string; p_now: string; p_opens: string }
        Returns: string
      }
      event_has_legacy_bonus_payment: {
        Args: { p_event_id: string }
        Returns: boolean
      }
      event_results_fingerprint: { Args: { p_event_id: string }; Returns: Json }
      fill_event_from_waitlist: {
        Args: { p_actor: string; p_event_id: string; p_waitlist_id?: string }
        Returns: Json
      }
      format_best_of: {
        Args: { p_format: Database["public"]["Enums"]["match_format"] }
        Returns: number
      }
      format_cap: {
        Args: { p_format: Database["public"]["Enums"]["match_format"] }
        Returns: number
      }
      format_target: {
        Args: { p_format: Database["public"]["Enums"]["match_format"] }
        Returns: number
      }
      forms_api_import_registration: {
        Args: { p_binding_id: string; p_payload: Json }
        Returns: {
          event_id: string
          item: number
          reason: string
          replayed: boolean
          status: string
        }[]
      }
      get_active_season: {
        Args: Record<PropertyKey, never>
        Returns: {
          competitive_fee_cents: number
          id: string
          name: string
          recreational_fee_cents: number
        }[]
      }
      get_event_multiplier: {
        Args: { evt: Database["public"]["Enums"]["event_type_enum"] }
        Returns: number
      }
      get_executives: {
        Args: Record<PropertyKey, never>
        Returns: {
          bio: string
          exec_photo_url: string
          exec_title: string
          id: string
          name: string
        }[]
      }
      get_format_weight: {
        Args: { fmt: Database["public"]["Enums"]["match_format"] }
        Returns: number
      }
      get_leaderboard: {
        Args: Record<PropertyKey, never>
        Returns: {
          avatar_url: string
          current_doubles_streak: number
          current_singles_streak: number
          doubles_elo: number
          doubles_losses: number
          doubles_provisional: boolean
          doubles_wins: number
          handle: string
          id: string
          name: string
          singles_elo: number
          singles_losses: number
          singles_provisional: boolean
          singles_wins: number
          status: Database["public"]["Enums"]["player_status"]
          tournament_points: number
        }[]
      }
      get_margin_multiplier: {
        Args: { p_games_lost: number; p_games_won: number }
        Returns: number
      }
      get_player_id: { Args: { p_user_id: string }; Returns: string }
      get_session_attendee_counts: {
        Args: { p_session_ids: string[] }
        Returns: { attendees: number; session_id: string }[]
      }
      has_passkeys: { Args: { p_user_id: string }; Returns: boolean }
      increment_challenges_issued: {
        Args: { p_player_id: string }
        Returns: undefined
      }
      is_admin: { Args: { p_user_id: string }; Returns: boolean }
      is_admin_or_coach: { Args: { p_user_id: string }; Returns: boolean }
      is_challenge_participant: {
        Args: { p_challenge_id: string; p_user_id: string }
        Returns: boolean
      }
      is_legal_game_score: {
        Args: {
          p_a: number
          p_b: number
          p_format: Database["public"]["Enums"]["match_format"]
        }
        Returns: boolean
      }
      is_legal_game_score_custom: {
        Args: { p_a: number; p_b: number; p_target: number }
        Returns: boolean
      }
      issue_passkey_challenge: {
        Args: {
          p_challenge_hash: string
          p_purpose: string
          p_ttl_seconds: number
          p_user_id: string
        }
        Returns: undefined
      }
      join_event_waitlist: {
        Args: {
          p_doubles: boolean
          p_event_id: string
          p_player_id: string
          p_user_agent?: string
          p_waiver_hash?: string
        }
        Returns: Json
      }
      leave_event_waitlist: {
        Args: { p_event_id: string; p_player_id: string }
        Returns: Json
      }
      mark_field_entries_no_show: {
        Args: { p_entry_ids: string[]; p_is_pair: boolean }
        Returns: Json
      }
      mark_tour_seen: {
        Args: { p_player_id: string; p_tour: string }
        Returns: Json
      }
      match_counts_toward_stats: {
        Args: {
          p_result_status: Database["public"]["Enums"]["result_status"]
          p_walkover_type: Database["public"]["Enums"]["walkover_type"]
        }
        Returns: boolean
      }
      merge_my_notification_preferences: {
        Args: { p_patch: Json }
        Returns: Json
      }
      merge_notification_preferences_by_email: {
        Args: { p_email: string; p_patch: Json }
        Returns: Json
      }
      merge_players: {
        Args: { p_actor: string; p_keep: string; p_remove: string }
        Returns: Json
      }
      merge_players_disposable: {
        Args: Record<PropertyKey, never>
        Returns: { col: string; tbl: string }[]
      }
      merge_players_preview: {
        Args: { p_keep: string; p_remove: string }
        Returns: { effect: string; row_count: number; table_name: string }[]
      }
      merge_players_unhandled: {
        Args: Record<PropertyKey, never>
        Returns: { col: string; tbl: string }[]
      }
      pair_tournament_entrants: {
        Args: {
          p_added_by: string
          p_combined_elo: number
          p_event_id: string
          p_pair_name: string
          p_player1_id: string
          p_player2_id: string
        }
        Returns: string
      }
      platform_setting_bool: {
        Args: { p_default: boolean; p_key: string; p_section: string }
        Returns: boolean
      }
      platform_setting_int: {
        Args: { p_default: number; p_key: string; p_section: string }
        Returns: number
      }
      platform_setting_numeric: {
        Args: { p_default: number; p_key: string; p_section: string }
        Returns: number
      }
      points_cap: { Args: { p_target: number }; Returns: number }
      post_club_changes: {
        Args: {
          p_actor: string
          p_discard_ids: string[]
          p_discard_revisions: number[]
          p_draft_ids: string[]
          p_intro: string
          p_lines: string[]
          p_revisions: number[]
          p_title: string
        }
        Returns: string
      }
      promote_pool_qualifier: {
        Args: {
          p_admin_id: string
          p_checked_in_at: string
          p_doubles: boolean
          p_elo: number
          p_event_id: string
          p_pair_name: string
          p_player1_id: string
          p_player2_id: string
          p_seed: number
          p_source_event_id: string
        }
        Returns: Json
      }
      publish_event_draw: {
        Args: {
          p_digests: Json
          p_doubles: boolean
          p_entrants: string[]
          p_event_id: string
          p_generation: string
          p_new_status: string
          p_phase: string
          p_whole_field: boolean
        }
        Returns: Json
      }
      publish_stage_draw: {
        Args: {
          p_digests: Json
          p_doubles: boolean
          p_entrants: string[]
          p_event_id: string
          p_generation: string
          p_source_fingerprint: Json
          p_stage: number
        }
        Returns: Json
      }
      rating_bounds: {
        Args: Record<PropertyKey, never>
        Returns: { hi: number; lo: number }
      }
      rating_setting_int: {
        Args: { p_default: number; p_key: string }
        Returns: number
      }
      recompute_head_to_head_pair: {
        Args: {
          p_match_type: Database["public"]["Enums"]["match_type_enum"]
          p_player_a: string
          p_player_b: string
        }
        Returns: boolean
      }
      recompute_partnership_pair: {
        Args: { p_player_a: string; p_player_b: string }
        Returns: boolean
      }
      recompute_player_stats: { Args: { p_player: string }; Returns: number }
      record_registration_form_poll: {
        Args: {
          p_binding_id: string
          p_claimed_at: string
          p_error: string
          p_imported: number
          p_read: boolean
          p_watermark: string
        }
        Returns: boolean
      }
      reject_walkover_atomic: {
        Args: { p_admin_id: string; p_walkover_id: string }
        Returns: Json
      }
      remove_field_entry: {
        Args: { p_entry_id: string; p_is_pair: boolean }
        Returns: Json
      }
      remove_from_event_waitlist: {
        Args: { p_actor: string; p_waitlist_id: string }
        Returns: Json
      }
      report_walkover_atomic: {
        Args: {
          p_challenge_id: string
          p_forfeit_player_id: string
          p_notice_hours?: number
          p_walkover_type: string
        }
        Returns: Json
      }
      resolve_dispute_rated: {
        Args: {
          p_admin_id: string
          p_dispute_id: string
          p_games?: Json
          p_resolution_note?: string
          p_resolution_type: Database["public"]["Enums"]["dispute_resolution"]
          p_winner_side?: Database["public"]["Enums"]["team_side"]
        }
        Returns: Json
      }
      resolve_dispute_unrated: {
        Args: {
          p_actor_id: string
          p_dispute_id: string
          p_resolution_note?: string
          p_resolution_type: Database["public"]["Enums"]["dispute_resolution"]
        }
        Returns: Json
      }
      respond_to_challenge: {
        Args: { p_challenge_id: string; p_response: string }
        Returns: Json
      }
      reverse_match_result: { Args: { p_match_id: string }; Returns: undefined }
      reverse_tournament_match_rating: {
        Args: { p_match_id: string }
        Returns: undefined
      }
      rewrite_event_placings_under_field_lock: {
        Args: {
          p_clear: string[]
          p_event_id: string
          p_is_pair: boolean
          p_points: Json
          p_positions: Json
          p_results: Json
        }
        Returns: Json
      }
      scrub_deleted_identity: {
        Args: Record<PropertyKey, never>
        Returns: { audit_rows_scrubbed: number; auth_rows_scrubbed: number }[]
      }
      session_cap_for: { Args: { p_match_type: string }; Returns: number }
      session_checkin_open: { Args: { p_session_id: string }; Returns: boolean }
      set_event_waitlist: {
        Args: {
          p_actor: string
          p_auto: boolean
          p_enabled: boolean
          p_event_id: string
        }
        Returns: Json
      }
      set_field_entry_group: {
        Args: { p_entry_id: string; p_group: number; p_is_pair: boolean }
        Returns: Json
      }
      set_field_entry_seed: {
        Args: { p_entry_id: string; p_is_pair: boolean; p_seed: number }
        Returns: Json
      }
      set_field_entry_status: {
        Args: {
          p_actor: string
          p_entry_id: string
          p_is_pair: boolean
          p_new_status: string
        }
        Returns: Json
      }
      set_field_groups: {
        Args: {
          p_assignments: Json
          p_event_id: string
          p_expected: string[]
          p_is_pair: boolean
        }
        Returns: Json
      }
      set_match_ready: {
        Args: { p_match_id: string; p_player_id: string; p_ready: boolean }
        Returns: string[]
      }
      set_my_media_consent: {
        Args: { p_consent: boolean }
        Returns: {
          media_consent: boolean
          media_consent_changed_at: string
        }[]
      }
      staged_source_fingerprint: {
        Args: { p_event_id: string; p_stage: number }
        Returns: Json
      }
      strip_identity_keys: { Args: { v: Json }; Returns: Json }
      submit_match_result: {
        Args: { p_challenge_id: string; p_completed?: boolean; p_games: Json }
        Returns: string
      }
      submit_match_result_for: {
        Args: {
          p_actor: string
          p_challenge_id: string
          p_completed?: boolean
          p_duration_minutes?: number
          p_games: Json
        }
        Returns: string
      }
      swap_tournament_pair_member: {
        Args: {
          p_added_by: string
          p_combined_elo: number
          p_incoming_player_id: string
          p_outgoing_player_id: string
          p_pair_id: string
          p_pair_name: string
        }
        Returns: undefined
      }
      sweep_unledgered_bonus_events: {
        Args: Record<PropertyKey, never>
        Returns: { marked_event_id: string; marked_event_type: string }[]
      }
      unpair_tournament_pair: {
        Args: {
          p_added_by: string
          p_pair_id: string
          p_reason: string
          p_withdrawn_player_id: string
        }
        Returns: string[]
      }
      update_head_to_head: { Args: { p_match_id: string }; Returns: undefined }
      update_partnership_stats: {
        Args: { p_match_id: string }
        Returns: undefined
      }
      validate_challenge_creation: {
        Args: {
          p_creator_id: string
          p_opponent_id: string
          p_opponent_partner_id?: string
          p_partner_id?: string
          p_type: string
        }
        Returns: Json
      }
      void_club_match: {
        Args: { p_actor_id: string; p_match_id: string; p_reason: string }
        Returns: Json
      }
      withdraw_from_tournament_event: {
        Args: { p_event_id: string; p_player_id: string }
        Returns: Json
      }
    }
    Enums: {
      announcement_audience:
        | "all"
        | "competitive"
        | "recreational"
        | "eligible_only"
      announcement_status: "draft" | "published"
      announcement_type: "info" | "warning" | "urgent" | "event"
      attendance_status: "checked_in" | "present" | "no_show" | "excused"
      challenge_status:
        | "proposed"
        | "partially_confirmed"
        | "accepted"
        | "rejected"
        | "expired"
        | "cancelled"
        | "completed"
        | "disputed"
        | "walkover_pending"
        | "walkover_confirmed"
      confirmation_status: "pending" | "accepted" | "rejected"
      dispute_reason:
        | "score_wrong"
        | "winner_wrong"
        | "format_wrong"
        | "incomplete"
        | "abuse"
        | "rules_violation"
        | "other"
      dispute_resolution:
        | "accepted"
        | "edited"
        | "voided"
        | "converted_to_casual"
      dispute_status: "open" | "under_review" | "resolved"
      event_type_enum:
        | "rated_challenge"
        | "casual"
        | "tournament"
        | "trial"
        | "admin_entered"
      match_format: "bo3_21" | "single_21" | "single_15" | "single_11"
      match_type_enum: "singles" | "doubles"
      membership_type: "internal" | "alumni" | "external"
      notification_type:
        | "challenge_received"
        | "challenge_accepted"
        | "challenge_rejected"
        | "challenge_expired"
        | "challenge_cancelled"
        | "result_pending"
        | "result_confirmed"
        | "dispute_opened"
        | "dispute_resolved"
        | "rank_changed"
        | "session_reminder"
        | "walkover_reported"
        | "walkover_confirmed"
        | "opponent_withdrew"
        | "admin_alert"
        | "general"
        | "tournament_bracket_published"
        | "tournament_match_ready"
        | "tournament_match_result"
        | "tournament_event_completed"
        | "tournament_checkin_open"
      participant_role:
        | "challenger"
        | "opponent"
        | "partner"
        | "opponent_partner"
      player_status:
        | "competitive"
        | "recreational"
        | "pending_approval"
        | "suspended"
      result_status:
        | "pending_submission"
        | "pending_confirmation"
        | "confirmed"
        | "disputed"
        | "voided"
        | "walkover"
        | "incomplete"
      season_term: "fall" | "spring" | "summer"
      session_group: "competitive" | "recreational" | "all"
      session_intent: "going" | "declined"
      session_status: "open" | "closed"
      team_side: "a" | "b"
      tournament_status: "draft" | "active" | "completed" | "archived"
      user_role: "player" | "admin"
      walkover_status: "pending" | "confirmed" | "rejected"
      walkover_type: "withdrawal" | "no_show"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      announcement_audience: [
        "all",
        "competitive",
        "recreational",
        "eligible_only",
      ],
      announcement_status: ["draft", "published"],
      announcement_type: ["info", "warning", "urgent", "event"],
      attendance_status: ["checked_in", "present", "no_show", "excused"],
      challenge_status: [
        "proposed",
        "partially_confirmed",
        "accepted",
        "rejected",
        "expired",
        "cancelled",
        "completed",
        "disputed",
        "walkover_pending",
        "walkover_confirmed",
      ],
      confirmation_status: ["pending", "accepted", "rejected"],
      dispute_reason: [
        "score_wrong",
        "winner_wrong",
        "format_wrong",
        "incomplete",
        "abuse",
        "rules_violation",
        "other",
      ],
      dispute_resolution: [
        "accepted",
        "edited",
        "voided",
        "converted_to_casual",
      ],
      dispute_status: ["open", "under_review", "resolved"],
      event_type_enum: [
        "rated_challenge",
        "casual",
        "tournament",
        "trial",
        "admin_entered",
      ],
      match_format: ["bo3_21", "single_21", "single_15", "single_11"],
      match_type_enum: ["singles", "doubles"],
      membership_type: ["internal", "alumni", "external"],
      notification_type: [
        "challenge_received",
        "challenge_accepted",
        "challenge_rejected",
        "challenge_expired",
        "challenge_cancelled",
        "result_pending",
        "result_confirmed",
        "dispute_opened",
        "dispute_resolved",
        "rank_changed",
        "session_reminder",
        "walkover_reported",
        "walkover_confirmed",
        "opponent_withdrew",
        "admin_alert",
        "general",
        "tournament_bracket_published",
        "tournament_match_ready",
        "tournament_match_result",
        "tournament_event_completed",
        "tournament_checkin_open",
      ],
      participant_role: [
        "challenger",
        "opponent",
        "partner",
        "opponent_partner",
      ],
      player_status: [
        "competitive",
        "recreational",
        "pending_approval",
        "suspended",
      ],
      result_status: [
        "pending_submission",
        "pending_confirmation",
        "confirmed",
        "disputed",
        "voided",
        "walkover",
        "incomplete",
      ],
      season_term: ["fall", "spring", "summer"],
      session_group: ["competitive", "recreational", "all"],
      session_intent: ["going", "declined"],
      session_status: ["open", "closed"],
      team_side: ["a", "b"],
      tournament_status: ["draft", "active", "completed", "archived"],
      user_role: ["player", "admin"],
      walkover_status: ["pending", "confirmed", "rejected"],
      walkover_type: ["withdrawal", "no_show"],
    },
  },
} as const

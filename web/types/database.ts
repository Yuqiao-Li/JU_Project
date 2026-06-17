export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      answers: {
        Row: {
          created_at: string
          guest_id: string
          id: string
          question_id: string
          value: Json
        }
        Insert: {
          created_at?: string
          guest_id: string
          id?: string
          question_id: string
          value: Json
        }
        Update: {
          created_at?: string
          guest_id?: string
          id?: string
          question_id?: string
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "answers_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      broadcasts: {
        Row: {
          body: string
          channel: string
          created_at: string
          event_id: string
          id: string
          sent_at: string | null
        }
        Insert: {
          body: string
          channel: string
          created_at?: string
          event_id: string
          id?: string
          sent_at?: string | null
        }
        Update: {
          body?: string
          channel?: string
          created_at?: string
          event_id?: string
          id?: string
          sent_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "broadcasts_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      comment_reactions: {
        Row: {
          comment_id: string
          created_at: string
          emoji: string
          guest_id: string
          id: string
        }
        Insert: {
          comment_id: string
          created_at?: string
          emoji: string
          guest_id: string
          id?: string
        }
        Update: {
          comment_id?: string
          created_at?: string
          emoji?: string
          guest_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comment_reactions_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comment_reactions_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      comments: {
        Row: {
          body: string
          created_at: string
          event_id: string
          gif_url: string | null
          guest_id: string | null
          host_id: string | null
          id: string
        }
        Insert: {
          body: string
          created_at?: string
          event_id: string
          gif_url?: string | null
          guest_id?: string | null
          host_id?: string | null
          id?: string
        }
        Update: {
          body?: string
          created_at?: string
          event_id?: string
          gif_url?: string | null
          guest_id?: string | null
          host_id?: string | null
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comments_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      date_options: {
        Row: {
          created_at: string
          ends_at: string | null
          event_id: string
          id: string
          starts_at: string
        }
        Insert: {
          created_at?: string
          ends_at?: string | null
          event_id: string
          id?: string
          starts_at: string
        }
        Update: {
          created_at?: string
          ends_at?: string | null
          event_id?: string
          id?: string
          starts_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "date_options_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      date_votes: {
        Row: {
          created_at: string
          date_option_id: string
          guest_id: string
          id: string
        }
        Insert: {
          created_at?: string
          date_option_id: string
          guest_id: string
          id?: string
        }
        Update: {
          created_at?: string
          date_option_id?: string
          guest_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "date_votes_date_option_id_fkey"
            columns: ["date_option_id"]
            isOneToOne: false
            referencedRelation: "date_options"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "date_votes_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      event_hosts: {
        Row: {
          created_at: string
          event_id: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          role?: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_hosts_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_hosts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      event_photos: {
        Row: {
          created_at: string
          event_id: string
          guest_id: string | null
          host_id: string | null
          id: string
          image_url: string
        }
        Insert: {
          created_at?: string
          event_id: string
          guest_id?: string | null
          host_id?: string | null
          id?: string
          image_url: string
        }
        Update: {
          created_at?: string
          event_id?: string
          guest_id?: string | null
          host_id?: string | null
          id?: string
          image_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_photos_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_photos_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_photos_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          allow_photo_upload: boolean
          allow_plus_ones: boolean
          anonymize_guest_list: boolean
          capacity: number | null
          chip_in_note: string | null
          chip_in_url: string | null
          cover_image_url: string | null
          created_at: string
          date_tbd: boolean
          description: string | null
          effect: string | null
          ends_at: string | null
          guest_approval_enabled: boolean
          hide_feed_timestamps: boolean
          hide_guest_count: boolean
          hide_guest_list: boolean
          host_id: string
          id: string
          lat: number | null
          lng: number | null
          location_city: string | null
          location_text: string | null
          location_url: string | null
          max_plus_ones: number
          rsvp_enabled: boolean
          slug: string
          starts_at: string | null
          status: string
          theme: Json
          title: string
          updated_at: string
          view_password_hash: string | null
          visibility: string
        }
        Insert: {
          allow_photo_upload?: boolean
          allow_plus_ones?: boolean
          anonymize_guest_list?: boolean
          capacity?: number | null
          chip_in_note?: string | null
          chip_in_url?: string | null
          cover_image_url?: string | null
          created_at?: string
          date_tbd?: boolean
          description?: string | null
          effect?: string | null
          ends_at?: string | null
          guest_approval_enabled?: boolean
          hide_feed_timestamps?: boolean
          hide_guest_count?: boolean
          hide_guest_list?: boolean
          host_id: string
          id?: string
          lat?: number | null
          lng?: number | null
          location_city?: string | null
          location_text?: string | null
          location_url?: string | null
          max_plus_ones?: number
          rsvp_enabled?: boolean
          slug?: string
          starts_at?: string | null
          status?: string
          theme?: Json
          title: string
          updated_at?: string
          view_password_hash?: string | null
          visibility?: string
        }
        Update: {
          allow_photo_upload?: boolean
          allow_plus_ones?: boolean
          anonymize_guest_list?: boolean
          capacity?: number | null
          chip_in_note?: string | null
          chip_in_url?: string | null
          cover_image_url?: string | null
          created_at?: string
          date_tbd?: boolean
          description?: string | null
          effect?: string | null
          ends_at?: string | null
          guest_approval_enabled?: boolean
          hide_feed_timestamps?: boolean
          hide_guest_count?: boolean
          hide_guest_list?: boolean
          host_id?: string
          id?: string
          lat?: number | null
          lng?: number | null
          location_city?: string | null
          location_text?: string | null
          location_url?: string | null
          max_plus_ones?: number
          rsvp_enabled?: boolean
          slug?: string
          starts_at?: string | null
          status?: string
          theme?: Json
          title?: string
          updated_at?: string
          view_password_hash?: string | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_host_id_fkey"
            columns: ["host_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      guests: {
        Row: {
          contact: string | null
          created_at: string
          display_name: string
          event_id: string
          guest_token: string
          id: string
          user_id: string | null
        }
        Insert: {
          contact?: string | null
          created_at?: string
          display_name: string
          event_id: string
          guest_token?: string
          id?: string
          user_id?: string | null
        }
        Update: {
          contact?: string | null
          created_at?: string
          display_name?: string
          event_id?: string
          guest_token?: string
          id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "guests_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          username: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          username?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          username?: string | null
        }
        Relationships: []
      }
      questions: {
        Row: {
          created_at: string
          event_id: string
          id: string
          options: Json | null
          position: number
          prompt: string
          required: boolean
          type: string
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          options?: Json | null
          position?: number
          prompt: string
          required?: boolean
          type: string
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          options?: Json | null
          position?: number
          prompt?: string
          required?: boolean
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "questions_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limits: {
        Row: {
          bucket_key: string
          count: number
          id: string
          window_start: string
        }
        Insert: {
          bucket_key: string
          count?: number
          id?: string
          window_start: string
        }
        Update: {
          bucket_key?: string
          count?: number
          id?: string
          window_start?: string
        }
        Relationships: []
      }
      rsvps: {
        Row: {
          approval_status: string
          created_at: string
          event_id: string
          guest_id: string
          id: string
          plus_ones: number
          status: string
          updated_at: string
        }
        Insert: {
          approval_status?: string
          created_at?: string
          event_id: string
          guest_id: string
          id?: string
          plus_ones?: number
          status: string
          updated_at?: string
        }
        Update: {
          approval_status?: string
          created_at?: string
          event_id?: string
          guest_id?: string
          id?: string
          plus_ones?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rsvps_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rsvps_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_reminders: {
        Row: {
          channel: string
          created_at: string
          event_id: string
          guest_id: string | null
          id: string
          remind_at: string
          sent_at: string | null
          status: string
        }
        Insert: {
          channel: string
          created_at?: string
          event_id: string
          guest_id?: string | null
          id?: string
          remind_at: string
          sent_at?: string | null
          status?: string
        }
        Update: {
          channel?: string
          created_at?: string
          event_id?: string
          guest_id?: string | null
          id?: string
          remind_at?: string
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_reminders_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_reminders_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_comment: {
        Args: {
          body?: string
          client_fingerprint?: string
          guest_token?: string
          slug: string
        }
        Returns: Json
      }
      add_date_option: {
        Args: { ends_at?: string; event_id: string; starts_at: string }
        Returns: Json
      }
      finalize_date: {
        Args: { event_id: string; option_id: string }
        Returns: Json
      }
      generate_event_slug: { Args: { title: string }; Returns: string }
      get_comments: {
        Args: { guest_token?: string; slug: string }
        Returns: Json
      }
      get_date_poll: {
        Args: { guest_token?: string; slug: string }
        Returns: Json
      }
      get_event_by_slug: {
        Args: {
          guest_token?: string
          password?: string
          password_verified?: boolean
          slug: string
        }
        Returns: Json
      }
      get_guest_list: {
        Args: { guest_token?: string; slug: string }
        Returns: Json
      }
      get_my_events: { Args: never; Returns: Json }
      get_public_events_by_host: { Args: { username: string }; Returns: Json }
      guest_unlock_status: {
        Args: { event_id: string; token?: string }
        Returns: Record<string, unknown>
      }
      promote_guest: { Args: { rsvp_id: string }; Returns: Json }
      remove_date_option: { Args: { option_id: string }; Returns: Json }
      set_event_password: {
        Args: { event_id: string; password: string }
        Returns: undefined
      }
      slug_random_suffix: { Args: { n?: number }; Returns: string }
      slugify: { Args: { input: string }; Returns: string }
      submit_rsvp: {
        Args: {
          client_fingerprint?: string
          contact?: string
          display_name: string
          guest_token?: string
          plus_ones?: number
          slug: string
          status?: string
        }
        Returns: Json
      }
      verify_event_password: {
        Args: { password: string; slug: string }
        Returns: boolean
      }
      vote_dates: {
        Args: { guest_token?: string; option_ids?: string[]; slug: string }
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
  public: {
    Enums: {},
  },
} as const

